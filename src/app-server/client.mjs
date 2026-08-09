import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_SERVER_CLIENT_NAME,
  APP_SERVER_CLIENT_TITLE,
  APP_SERVER_REQUEST_TIMEOUT_MS,
  APP_SERVER_TURN_TIMEOUT_MS,
  MAX_APP_SERVER_FRAME_BYTES,
  MAX_PROMPT_LENGTH,
  MAX_RESPONSE_BYTES,
  PACKAGE_VERSION,
  STUDY_ASSISTANT_INSTRUCTIONS,
} from '../constants.mjs';
import {
  AppServerProtocolError,
  encodeAppServerMessage,
  parseAppServerFrame,
  toSafeAccount,
} from './protocol.mjs';

const UNSAFE_ITEM_TYPES = new Set([
  'collabAgentToolCall',
  'commandExecution',
  'dynamicToolCall',
  'fileChange',
  'imageGeneration',
  'imageView',
  'mcpToolCall',
  'subAgentActivity',
  'webSearch',
]);

export class ConnectorBusyError extends Error {
  constructor() {
    super('Wait for the current answer to finish.');
    this.name = 'ConnectorBusyError';
  }
}

export class UnsafeToolActivityError extends Error {
  constructor() {
    super('Codex attempted an action that the study connector does not allow.');
    this.name = 'UnsafeToolActivityError';
  }
}

const defaultWorkspace = join(tmpdir(), 'bookarium-codex-connector', 'workspace');

export class CodexAppServerClient {
  constructor({
    appServerArgs = ['app-server', '--listen', 'stdio://', '--config', 'mcp_servers={}'],
    command = 'codex',
    environment = process.env,
    maximumFrameBytes = MAX_APP_SERVER_FRAME_BYTES,
    maximumResponseBytes = MAX_RESPONSE_BYTES,
    onDiagnostic = () => {},
    requestTimeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS,
    spawnProcess = spawn,
    turnTimeoutMs = APP_SERVER_TURN_TIMEOUT_MS,
    workspace = defaultWorkspace,
  } = {}) {
    this.appServerArgs = [...appServerArgs];
    this.command = command;
    this.environment = environment;
    this.maximumFrameBytes = maximumFrameBytes;
    this.maximumResponseBytes = maximumResponseBytes;
    this.onDiagnostic = onDiagnostic;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.turnTimeoutMs = turnTimeoutMs;
    this.workspace = workspace;

    this.activeTurn = null;
    this.busy = false;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.process = null;
    this.ready = false;
    this.startPromise = null;
    this.stdoutBuffer = Buffer.alloc(0);
  }

  async start() {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.#startProcess();
    try {
      await this.startPromise;
      this.ready = true;
    } catch (error) {
      await this.stop();
      this.startPromise = null;
      throw error;
    }
  }

  async #startProcess() {
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    const child = this.spawnProcess(this.command, this.appServerArgs, {
      cwd: this.workspace,
      env: this.environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      throw new Error('Codex App Server did not provide stdio streams.');
    }

    this.process = child;
    child.once('error', () => this.#fail(new Error('Codex App Server could not be started.')));
    child.once('exit', () => this.#fail(new Error('Codex App Server stopped unexpectedly.')));
    child.stdout.on('data', (chunk) => this.#handleStdout(chunk));
    child.stderr.on('data', () => this.onDiagnostic('codex-stderr'));

    await this.request('initialize', {
      clientInfo: {
        name: APP_SERVER_CLIENT_NAME,
        title: APP_SERVER_CLIENT_TITLE,
        version: PACKAGE_VERSION,
      },
    });
    this.notify('initialized', {});
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error('Codex App Server is not running.'));
    }
    if (typeof method !== 'string' || !method || !params || typeof params !== 'object') {
      return Promise.reject(new AppServerProtocolError('Invalid App Server request.'));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex App Server ${method} request timed out.`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, { reject, resolve, timer });

      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  async readAccount() {
    await this.start();
    const result = await this.request('account/read', { refreshToken: false });
    return toSafeAccount(result);
  }

  async ask(prompt) {
    const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!normalizedPrompt) throw new Error('A study prompt is required.');
    if (normalizedPrompt.length > MAX_PROMPT_LENGTH) throw new Error('The study prompt is too long.');
    if (this.busy) throw new ConnectorBusyError();
    this.busy = true;
    let threadId = null;

    try {
      await this.start();
      const threadResult = await this.request('thread/start', {
        approvalPolicy: 'never',
        baseInstructions: STUDY_ASSISTANT_INSTRUCTIONS,
        cwd: this.workspace,
        developerInstructions: STUDY_ASSISTANT_INSTRUCTIONS,
        ephemeral: true,
        personality: 'friendly',
        sandbox: 'read-only',
        serviceName: APP_SERVER_CLIENT_NAME,
      });
      threadId = threadResult?.thread?.id;
      if (typeof threadId !== 'string' || !threadId || threadResult?.thread?.ephemeral !== true) {
        throw new AppServerProtocolError('Codex did not create an ephemeral tutor thread.');
      }

      let completionResolve;
      let completionReject;
      const completion = new Promise((resolve, reject) => {
        completionResolve = resolve;
        completionReject = reject;
      });
      const timer = setTimeout(() => {
        this.#settleActive(new Error('Codex took too long to answer.'), true);
        this.#interruptActiveTurn();
      }, this.turnTimeoutMs);
      timer.unref?.();
      this.activeTurn = {
        answerByItemId: new Map(),
        finalAnswer: '',
        reject: completionReject,
        resolve: completionResolve,
        settled: false,
        threadId,
        timer,
        turnId: null,
      };

      try {
        const turnResult = await this.request('turn/start', {
          approvalPolicy: 'never',
          effort: 'low',
          input: [{ type: 'text', text: normalizedPrompt }],
          personality: 'friendly',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          threadId,
        });
        const turnId = turnResult?.turn?.id;
        if (typeof turnId !== 'string' || !turnId) {
          throw new AppServerProtocolError('Codex did not start a tutor turn.');
        }
        if (this.activeTurn) this.activeTurn.turnId = turnId;
      } catch (error) {
        this.#settleActive(error, true);
        await completion.catch(() => {});
        throw error;
      }

      return await completion;
    } finally {
      if (this.activeTurn?.timer) clearTimeout(this.activeTurn.timer);
      this.activeTurn = null;
      this.busy = false;
      if (threadId && this.process?.stdin?.writable) {
        void this.request('thread/unsubscribe', { threadId }).catch(() => {});
      }
    }
  }

  async stop() {
    const child = this.process;
    this.process = null;
    this.ready = false;
    this.startPromise = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.#failPending(new Error('Codex App Server stopped.'));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise((resolve) => {
      child.once('error', resolve);
      child.once('exit', resolve);
    });
    child.kill();
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000);
        timer.unref?.();
      }),
    ]);
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  #send(message) {
    if (!this.process?.stdin?.writable) throw new Error('Codex App Server is not running.');
    this.process.stdin.write(encodeAppServerMessage(message));
  }

  #handleStdout(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maximumFrameBytes) {
        this.#fatalProtocol();
        return;
      }
      let frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length === 0) continue;

      try {
        this.#handleMessage(parseAppServerFrame(frame, this.maximumFrameBytes));
      } catch {
        this.#fatalProtocol();
        return;
      }
    }

    if (this.stdoutBuffer.length > this.maximumFrameBytes) this.#fatalProtocol();
  }

  #handleMessage(message) {
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        const code = typeof message.error.code === 'number' ? ` (${message.error.code})` : '';
        pending.reject(new Error(`Codex App Server request failed${code}.`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (hasId && message.method) {
      this.#send({
        id: message.id,
        error: { code: -32_601, message: 'Bookarium does not expose host actions.' },
      });
      if (this.activeTurn) {
        this.#settleActive(new UnsafeToolActivityError(), true);
        this.#interruptActiveTurn();
      }
      return;
    }

    const active = this.activeTurn;
    if (!active || active.settled || message.params?.threadId !== active.threadId) return;
    const messageTurnId = message.params?.turnId ?? message.params?.turn?.id ?? null;
    if (active.turnId && messageTurnId && messageTurnId !== active.turnId) return;

    const item = message.params?.item;
    if ((message.method === 'item/started' || message.method === 'item/completed')
      && UNSAFE_ITEM_TYPES.has(item?.type)) {
      this.#settleActive(new UnsafeToolActivityError(), true);
      this.#interruptActiveTurn();
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      const itemId = typeof message.params?.itemId === 'string' ? message.params.itemId : '_agent';
      const delta = typeof message.params?.delta === 'string' ? message.params.delta : '';
      const combined = `${active.answerByItemId.get(itemId) ?? ''}${delta}`;
      if (Buffer.byteLength(combined) > this.maximumResponseBytes) {
        this.#settleActive(new Error('Codex answer exceeded the connector response limit.'), true);
        this.#interruptActiveTurn();
      } else {
        active.answerByItemId.set(itemId, combined);
      }
      return;
    }

    if (message.method === 'item/completed' && item?.type === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (Buffer.byteLength(text) > this.maximumResponseBytes) {
        this.#settleActive(new Error('Codex answer exceeded the connector response limit.'), true);
        this.#interruptActiveTurn();
        return;
      }
      if (item.phase !== 'commentary') active.finalAnswer = text;
      return;
    }

    if (message.method !== 'turn/completed') return;
    const turn = message.params?.turn;
    if (active.turnId && turn?.id !== active.turnId) return;
    if (turn?.status !== 'completed') {
      this.#settleActive(new Error('Codex did not complete the tutor answer.'), true);
      return;
    }

    const streamedAnswers = [...active.answerByItemId.values()];
    const answer = (active.finalAnswer || streamedAnswers.at(-1) || '').trim();
    if (!answer) {
      this.#settleActive(new Error('Codex returned an empty answer.'), true);
      return;
    }
    this.#settleActive(answer, false);
  }

  #settleActive(value, rejected) {
    const active = this.activeTurn;
    if (!active || active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    if (rejected) active.reject(value);
    else active.resolve(value);
  }

  #interruptActiveTurn() {
    const { threadId, turnId } = this.activeTurn ?? {};
    if (!threadId || !turnId || !this.process?.stdin?.writable) return;
    void this.request('turn/interrupt', { threadId, turnId }, 2_000).catch(() => {});
  }

  #fatalProtocol() {
    this.onDiagnostic('invalid-app-server-frame');
    this.#fail(new AppServerProtocolError('Codex App Server protocol failed closed.'));
    const child = this.process;
    this.process = null;
    this.ready = false;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  #fail(error) {
    this.process = null;
    this.ready = false;
    this.startPromise = null;
    this.#failPending(error);
  }

  #failPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.#settleActive(error, true);
  }
}
