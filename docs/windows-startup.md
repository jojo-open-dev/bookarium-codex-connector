# Windows on-demand activation and optional startup decision

Status: revised for on-demand use on Windows 10/11.

## Primary decision

The connector registers the custom `bookarium-codex://connect` URI scheme below the current user's `HKCU\Software\Classes` registry boundary. A direct user click in Bookarium invokes the scheme, Windows launches the installed connector, and the page waits for loopback readiness before reusing its previously paired bearer token.

Microsoft documents protocol activation as the Windows mechanism through which another application, including a browser, launches a registered desktop application. Registrations for unpackaged applications can be per-user and persistent. See [App activation for Windows desktop apps](https://learn.microsoft.com/en-us/windows/apps/develop/launch/activate-an-app) and [Handle URI activation](https://learn.microsoft.com/en-us/windows/apps/develop/launch/handle-uri-activation-dotnet).

The registered shell command contains only the reviewed absolute `node.exe` path, the absolute installed connector binary, and the fixed internal `start-managed` action. It does not interpolate or pass the clicked URI and contains no origin, pairing value, browser token, prompt, Codex credential, or arbitrary command. Invoking any URI under the scheme can therefore do no more than start an already installed connector; authorization still requires the exact configured Bookarium origin and bearer token.

Creation reads the complete registry shape before accepting it. Repair or version replacement may replace the handler only when its current values exactly match lifecycle metadata previously recorded by this installation. Uninstall deletes the scheme only after a second exact ownership check; a missing entry is idempotent, while a conflicting or extended entry is left untouched and reported.

## Optional sign-in startup

Automatic startup is no longer the default. If the user explicitly installs with `--startup`, the connector registers one Windows shortcut named `Bookarium Codex Connector.lnk` in the current user's Startup folder. It does not use the all-users Startup folder, a service, or Task Scheduler.

Microsoft documents `shell:startup` as the Startup folder for the current user and recommends creating a shortcut there for applications that are not otherwise registered as startup apps. The documented path corresponds to `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`. Microsoft also documents that removing the link removes that startup entry. See [Configure Startup Applications in Windows](https://support.microsoft.com/en-us/windows/set-apps-to-run-automatically-when-you-start-your-device-a5b64b3e-4483-4dad-abc7-027a863e1c2e).

The shortcut is created through the Windows Script Host `WScript.Shell.CreateShortcut` interface. Microsoft documents setting a shortcut's target executable, command-line arguments, working directory, window style, and saving the link through that interface. See [Create a desktop shortcut with Windows Script Host](https://learn.microsoft.com/en-us/troubleshoot/windows-client/admin-development/create-desktop-shortcut-with-wsh).

### Shortcut contents

- Target: the absolute `node.exe` path used for the reviewed install.
- Arguments: the absolute installed connector binary followed by the internal managed-service command.
- Working directory: the exact active version directory.
- Window style: minimized, because `node.exe` is a console executable.
- Description: `Bookarium Codex Connector (per-user startup)`.

The shortcut contains no pairing token, control secret, Codex credential, origin, or learner data. Runtime secrets remain in the connector's per-user state file.

Creation and inspection use a fixed, UTF-16LE base64-encoded PowerShell program. Dynamic paths are passed in child-process environment variables rather than interpolated into PowerShell source or a shell command line. PowerShell itself is spawned with an argument array and without a shell.

### Startup safety and removal

The installer resolves the Startup path only below the supplied current-user `%APPDATA%` boundary and rejects links/junctions in connector-owned paths. It records the shortcut's exact path, target, arguments, working directory, and description in owned lifecycle metadata.

Before repair or uninstall replaces/deletes the shortcut, the connector reads it back and requires those fields to match the recorded entry. A missing shortcut is an idempotent state. A shortcut with the expected name but different contents is left untouched and reported as a conflict.

No administrative rights are requested. The implementation never writes to `shell:common startup`, `HKLM`, `HKCU\...\Run`, or a scheduled task.

## User-experience limitations

The browser or Windows may ask the user to confirm opening the registered connector application. If the scheme is unregistered or hijacked, Bookarium cannot reliably distinguish that from a cancelled launch; it must stop polling after a bounded timeout and present install/repair guidance.

Windows can show the Node console when protocol activation launches the current console executable, or minimized during optional sign-in startup. The connector does not hide that window by routing activation through an interpolated command shell. A later signed GUI launcher could improve this without changing the protocol or lifecycle ownership rules.
