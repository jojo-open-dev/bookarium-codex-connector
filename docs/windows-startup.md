# Windows per-user startup decision

Status: accepted for Milestone 2 on Windows 10/11.

## Decision

The connector registers one Windows shortcut named `Bookarium Codex Connector.lnk` in the current user's Startup folder. It does not use the all-users Startup folder, the registry, a service, or Task Scheduler.

Microsoft documents `shell:startup` as the Startup folder for the current user and recommends creating a shortcut there for applications that are not otherwise registered as startup apps. The documented path corresponds to `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`. Microsoft also documents that removing the link removes that startup entry. See [Configure Startup Applications in Windows](https://support.microsoft.com/en-us/windows/set-apps-to-run-automatically-when-you-start-your-device-a5b64b3e-4483-4dad-abc7-027a863e1c2e).

The shortcut is created through the Windows Script Host `WScript.Shell.CreateShortcut` interface. Microsoft documents setting a shortcut's target executable, command-line arguments, working directory, window style, and saving the link through that interface. See [Create a desktop shortcut with Windows Script Host](https://learn.microsoft.com/en-us/troubleshoot/windows-client/admin-development/create-desktop-shortcut-with-wsh).

## Shortcut contents

- Target: the absolute `node.exe` path used for the reviewed install.
- Arguments: the absolute installed connector binary followed by the internal managed-service command.
- Working directory: the exact active version directory.
- Window style: minimized, because `node.exe` is a console executable.
- Description: `Bookarium Codex Connector (per-user startup)`.

The shortcut contains no pairing token, control secret, Codex credential, origin, or learner data. Runtime secrets remain in the connector's per-user state file.

Creation and inspection use a fixed, UTF-16LE base64-encoded PowerShell program. Dynamic paths are passed in child-process environment variables rather than interpolated into PowerShell source or a shell command line. PowerShell itself is spawned with an argument array and without a shell.

## Safety and removal

The installer resolves the Startup path only below the supplied current-user `%APPDATA%` boundary and rejects links/junctions in connector-owned paths. It records the shortcut's exact path, target, arguments, working directory, and description in owned lifecycle metadata.

Before repair or uninstall replaces/deletes the shortcut, the connector reads it back and requires those fields to match the recorded entry. A missing shortcut is an idempotent state. A shortcut with the expected name but different contents is left untouched and reported as a conflict.

No administrative rights are requested. The implementation never writes to `shell:common startup`, `HKLM`, or a scheduled task. The `HKCU\...\Run` registry location is not used because Microsoft cautions that registry modification can have unintended consequences, and a file-scoped shortcut is easier to inspect and remove narrowly.

## Known user-experience limitation

Windows can show the Node console minimized during sign-in. The connector does not hide that window by routing startup through an interpolated command shell. If a later signed GUI launcher is introduced, the shortcut target can be replaced without changing lifecycle ownership rules.
