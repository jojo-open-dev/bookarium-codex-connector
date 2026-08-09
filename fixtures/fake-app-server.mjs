import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const auditPath = process.env.FAKE_APP_SERVER_AUDIT_PATH;
let threadNumber = 0;
let turnNumber = 0;

const audit = (value) => {
  if (auditPath) appendFileSync(auditPath, `${JSON.stringify(value)}\n`, 'utf8');
};

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 2;
    return;
  }
  audit(message);

  if (message.method === 'initialize') {
    send({ id: message.id, result: { platformFamily: 'fake', userAgent: 'fake-app-server' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') {
    send({
      id: message.id,
      result: {
        account: {
          email: 'private@example.test',
          planType: 'plus',
          type: 'chatgpt',
        },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (message.method === 'thread/start') {
    threadNumber += 1;
    send({
      id: message.id,
      result: {
        thread: {
          ephemeral: message.params?.ephemeral === true,
          id: `thread-${threadNumber}`,
        },
      },
    });
    return;
  }
  if (message.method === 'turn/start') {
    turnNumber += 1;
    const threadId = message.params.threadId;
    const turnId = `turn-${turnNumber}`;
    const itemId = `agent-${turnNumber}`;
    const prompt = message.params.input?.[0]?.text ?? '';
    const answer = `Tutor: ${prompt}`;
    send({ id: message.id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } });

    if (process.env.FAKE_APP_SERVER_HOST_REQUEST === '1') {
      send({
        id: 900 + turnNumber,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'forbidden', threadId, turnId },
      });
      return;
    }
    if (process.env.FAKE_APP_SERVER_UNSAFE_TOOL === '1') {
      send({
        method: 'item/started',
        params: {
          item: { command: 'forbidden', id: itemId, status: 'inProgress', type: 'commandExecution' },
          threadId,
          turnId,
        },
      });
      return;
    }

    send({
      method: 'item/agentMessage/delta',
      params: { delta: answer, itemId, threadId, turnId },
    });
    send({
      method: 'item/completed',
      params: {
        item: { id: itemId, phase: 'final_answer', text: answer, type: 'agentMessage' },
        threadId,
        turnId,
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, items: [], status: 'completed' } },
    });
    return;
  }
  if (message.method === 'thread/unsubscribe' || message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    return;
  }

  if (Object.hasOwn(message, 'id') && !message.method) return;
  send({ id: message.id, error: { code: -32_601, message: 'Unknown fake method.' } });
});
