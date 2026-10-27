# Firstmate Discord bridge

Use a private Discord server to send text and screenshots to firstmate from your phone.
The bridge uses a Discord Gateway bot.
It does not use an incoming webhook, a public URL, or an MCP server.
It opens no incoming network port.

Read [the setup guide](docs/SETUP.md) to create the server and bot.
This project uses the MIT licence. See [LICENSE](LICENSE).
Use Node.js 22 or newer.
Do not install packages.

## How it works

```text
Phone -> Discord -> Gateway WebSocket -> bridge -> fm-inbox note -> firstmate
Phone <- Discord <- Discord REST API  <- bridge <- fm-inbox receipts
                                      ^
                                      |
                         task metadata and status files
```

The bridge accepts only the configured owner in one server and one channel or its threads.
It stores downloaded files in `data/media/<message-id>/`.
It sends the text and local file paths to the firstmate note queue.
Firstmate reads the note and publishes an answer.
The bridge sends that answer to the original channel or thread.
It checks answers every 3 seconds.
It checks task files every 10 seconds.

Set `KEEP_AWAKE_SECONDS=7200` to keep the Mac awake for two hours after each accepted owner message. Each new message starts the timer again. This setting needs macOS and the `caffeinate` tool. It does not prevent sleep when the lid is closed on battery. Leave the setting unset or set it to `0` to turn this feature off. Restart the bridge after you change the setting.

The bridge creates one public Discord thread for each task metadata file it finds.
A public thread in a private server is visible to members who can see its parent channel.
Keep only your account and the bot in this server.
The thread name is the task ID.
Task messages start with `[task <task-id>]` in the firstmate queue.
A message in the main channel is a general note.

## Run and test

```sh
node --version
node src/bridge.mjs --dry-run
node src/bridge.mjs --check
node src/bridge.mjs
node --test
```

Set the values in `.env` before you run these commands.
The dry run validates these values without a connection or a file write.
The check validates the bot token and local inbox path.
It prints the bot name.
It does not start the Gateway connection.
Tests use local files and fake network transports.
Tests do not use a Discord token or a real firstmate queue.

## Forward the terminal answer to Discord

`src/forward-final.mjs` sends the final Claude Code answer to Discord.
It makes no model call and uses no extra model tokens.
It replies to the most recent acknowledged Discord note without a recorded reply.
If no note waits for a reply, it posts the answer to the configured main channel.
It uses `fm-inbox.sh receipts` and the bridge note routes to find a waiting note.
It records a note reply with `fm-inbox.sh reply`.
The running bridge sends the reply to the original channel.
Keep the bridge running.
The hook keeps line breaks and splits long text at 1900 characters.

Add this entry to `hooks` in `/path/to/firstmate/.claude/settings.local.json`.
Keep this file untracked.
Keep any existing hook entries.
Do not add a second copy of this hook.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "FM_HOME=/path/to/firstmate node /path/to/firstmate-discord-bridge/src/forward-final.mjs",
            "timeout": 8
          }
        ]
      }
    ]
  }
}
```

Use Node.js 22 or newer on the Claude Code command path.
The hook reads `.env` and `data/state.json` from the bridge repository, not the session directory.
Set `FM_HOME` in the hook command to the firstmate repository path.
It removes the configured bot token from the answer.
The hook prints nothing and always exits with code 0.
Each inbox command has a 2.5-second time limit.
The hook has a 7-second time limit.

The hook uses `last_assistant_message` from the [Stop hook input](https://code.claude.com/docs/en/hooks#stop-input).
If this field is absent, it reads the last assistant message from the JSONL transcript.
It copies text blocks only, not thinking or tool calls.
The transcript can be incomplete when the hook starts.
The hook cannot recover text that is absent from both sources.
An empty answer or a single line that starts with `Captain, shipshape.` sends no reply.
The default receipts bounds can exclude older notes.

The hook sends text only, with no attachments.
It disables attachment instructions in lines that start with `FILE:`.
The bridge splits text at 1900 characters.
A terminal answer can answer only one Discord note.
The hook does not check whether the answer addresses that note.

Private records in `data/forward-final/` prevent a second send for the same transcript message ID.
A turn and text fingerprint also covers a payload whose transcript message is not yet saved.
If the transcript is incomplete or no turn ID is available, identical text in the same session can be suppressed.
The hook saves each record before it calls `reply`.
It does not retry an uncertain or failed reply.
Check `data/forward-final.log` and inbox receipts after a failure.
Keep these records to prevent repeated replies.

## Limits

- Use one bridge process for each data directory.
- Use a normal text channel as the parent channel.
- The bridge handles new messages, not message edits or direct messages.
- Gateway resume handles short connection failures.
- A full process restart starts a new Gateway session.
- Discord messages sent while the bridge is stopped are not imported from channel history.
- A saved inbound message remains in the local retry queue until note creation succeeds.
- A repeated message uses the same firstmate request ID.
- Files must not exceed 25,000,000 bytes each.
- A larger inbound file adds a size warning to the note instead of a local file path.
- An answer can include up to 10 files.
- Discord can apply a lower file limit to the server.
- Discord limits the complete upload request to 25 MiB.
- The bridge separates uploads to keep each request below that limit.
- Answer text is split at 1900 characters.
- Existing task metadata files also create threads on the first scan.
- Task IDs must start with a letter or digit.
- Task IDs can contain letters, digits, dots, underscores, and dashes.
- Task IDs must not exceed 100 characters.
- Only a `title=` or `title:` field in the metadata file supplies an opening title.
- Status messages contain only the task ID and the state word.
- Incomplete status lines wait for a newline.
- The bridge does not archive threads.
- Discord can archive inactive threads after seven days.
- The bridge does not remove local media or old state records.
- Keep a backup of the data directory.

## Delivery safety

`data/state.json` stores note routes, reply cursors, thread routes, status offsets, and delivery records.
The bridge saves each answer plan before it starts sending messages.
It checks file hashes before it sends queued attachments.
The bridge writes state through an atomic file replacement.
The bridge and the progress command share a file lock.

Each outgoing message has a fixed nonce and a saved delivery record.
A saved message ID prevents a second send.
After an uncertain send, the bridge checks channel history for the nonce.
It reads at most 10,000 recent messages for this check.
It stops that delivery if it cannot find proof of a successful send.
It does not send an uncertain message again.
This rule prevents duplicate answers but can require manual repair after a crash or network failure.
See [recovery instructions](docs/SETUP.md#delivery-recovery).
Discord does not provide a permanent transaction across its API and the local state file.

## Security

The bot token is a secret.
Never put the token in a chat or a repository.
The IDs and local paths are not authentication secrets.
They can still identify private resources.

Keep `.env`, media, state, and logs private.
The default ignore rules exclude these files.
New state files and downloaded files use owner-only permissions.
The bridge removes the configured token from error messages and forwarded text.
It does not remove other secrets from messages or files.
Do not send other secrets through this bridge.

The bridge ignores other authors and bot messages.
It disables Discord mentions in its outgoing messages.
It downloads attachments only from Discord attachment hosts over HTTPS.
It does not follow attachment redirects.
It stores files but never executes them.
Firstmate remains responsible for safe handling of note text and files.

Firstmate commands use an argument list, not a shell command string.
Outgoing files must resolve inside `FM_HOME/data` or the bridge media directory.
The bridge rejects a symbolic link that resolves outside these roots.
Protect these directories from changes by other local users.
A local user who controls the configuration or state can control the bridge.
