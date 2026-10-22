# Set up a private Discord bridge

## 1. Check the Mac

Keep firstmate and this bridge on the same Mac.
Use the local repository at `/path/to/firstmate-discord-bridge`.
Run this command in Terminal:

```sh
cd /path/to/firstmate-discord-bridge
node --version
```

Use Node.js 22 or newer.
The bridge refuses an older version.
Do not run a package installation command.
The bridge uses only Node.js built-in modules.
The firstmate home must contain an executable `bin/fm-inbox.sh`.
That command also requires the tools used by your firstmate installation, including Python 3.

## 2. Create a server only for you

Discord menu names can differ by version, language, and device.
The paths below describe the desktop interface.
A step marked **To be checked** needs a visual check in your Discord version.

1. Open Discord with your personal account.
2. Select the plus sign in the server list.
3. Select **Create My Own**.
4. Select **For me and my friends**, if Discord shows this choice.
5. Enter a server name.
6. Create the server.
7. Do not send an invite to another person.
8. Create a normal text channel named `firstmate`.
9. Keep only your account and the bot as server members.

**To be checked:** If the server menu has a public discovery or community option, leave it disabled.
A thread can have the Discord type **Public Thread** without making the server public.
Only members who can view its parent channel can view the thread.

## 3. Create the application and bot

1. Open <https://discord.com/developers/applications>.
2. Sign in with your Discord account.
3. Select **New Application**.
4. Enter an application name, such as `Firstmate Bridge`.
5. Create the application.
6. Open the application page.
7. Select **Bot** in the navigation list.
8. Create the bot if the page shows **Add Bot**.
9. Find the token controls.
10. Select **Reset Token**.
11. Complete the account check if Discord requests it.
12. Copy the new token into a local password manager.
13. Turn off **Public Bot** if this control is available.
14. Leave **Requires OAuth2 Code Grant** disabled if this control is available.
15. Find **Privileged Gateway Intents** on the Bot page.
16. Turn on **Message Content Intent**.
17. Save the changes.

**To be checked:** New applications can already have a bot user.
Look for the bot username and token controls instead of an **Add Bot** button.
Discord can move the installation controls between **Installation** and **OAuth2**.
Use a server installation with the `bot` scope.
This bridge does not need a user installation or the `applications.commands` scope.

**The bot token is a secret.**
Do not paste it into Discord, another chat, a source file, or a report.
Do not commit it to Git.
If the token becomes public, reset it in the Developer Portal.
Replace the local value after the reset.

## 4. Invite the bot with the required permissions

1. Open **OAuth2 > URL Generator** in the application page, if available.
2. Select the `bot` scope.
3. Select only these bot permissions:

| Permission | Bit |
| --- | ---: |
| View Channels | 10 |
| Send Messages | 11 |
| Send Messages in Threads | 38 |
| Create Public Threads | 35 |
| Read Message History | 16 |
| Attach Files | 15 |
| Add Reactions | 6 |

The combined permission value is `309237746752`.
Do not select **Administrator**.

4. Copy the generated URL.
5. Open the URL in your browser.
6. Select the private server you created.
7. Approve the listed permissions.
8. Confirm that the bot appears in the server member list.

**To be checked:** If **URL Generator** is absent, look for the server install link in **Installation**.
You can also use this URL after you replace `APPLICATION_ID` with the application ID from **General Information**:

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot&permissions=309237746752&integration_type=0
```

Keep the default permissions of the new text channel.
If you change channel permissions, give the bot all seven permissions in the table.
The bridge does not require **Manage Threads**.

## 5. Copy the three IDs

1. In desktop Discord, open **User Settings > Advanced**.
2. Turn on **Developer Mode**.
3. Close settings.
4. Right-click the server icon.
5. Select **Copy Server ID**.
6. Save this value as `DISCORD_GUILD_ID`.
7. Right-click the `firstmate` text channel.
8. Select **Copy Channel ID**.
9. Save this value as `DISCORD_CHANNEL_ID`.
10. Right-click your own user entry in the server member list.
11. Select **Copy User ID**.
12. Save this value as `DISCORD_OWNER_ID`.

Use your personal user ID, not the bot user ID.
Do not use a message ID or a thread ID as the parent channel ID.
IDs are long decimal numbers.
The IDs are not passwords.
Do not publish them without a reason.

**To be checked:** On mobile, look for **Settings > Advanced > Developer Mode**.
Long-press the server, channel, or your user profile to find its ID control.
The exact mobile settings path and menu placement can differ by version.
Use the desktop steps if you cannot find these controls.

## 6. Create the local configuration

Run these commands:

```sh
cd /path/to/firstmate-discord-bridge
cp .env.example .env
chmod 600 .env
open -e .env
```

Put the token in `DISCORD_BOT_TOKEN` in this local file.
Put each ID in its matching field.
Use one `NAME=value` entry per line.
The file parser does not expand shell variables.
An environment variable overrides the same value in `.env`.

| Name | Required value or default |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The secret bot token |
| `DISCORD_GUILD_ID` | Your private server ID |
| `DISCORD_CHANNEL_ID` | Your parent text channel ID |
| `DISCORD_OWNER_ID` | Your personal user ID |
| `FM_HOME` | `/path/to/firstmate` |
| `FM_INBOX_BIN` | Empty uses `FM_HOME/bin/fm-inbox.sh` |
| `BRIDGE_DATA_DIR` | Empty uses `./data` |

Use an absolute path for `FM_HOME` when you use launchd.
A relative bridge data path starts at the repository working directory.
Do not commit `.env`.
The repository ignore rules exclude it.

## 7. Check and start the bridge

Run the offline check first:

```sh
node src/bridge.mjs --dry-run
```

This command connects to nothing.
It prints the configured IDs, local paths, and planned actions.
It does not print the token.

Validate the token next:

```sh
node src/bridge.mjs --check
```

The command calls `GET /users/@me` with the bot token.
It prints the bot name and ID.
It also checks access to the local firstmate home and inbox command.
It does not check every server permission.

Start the bridge in the foreground:

```sh
node src/bridge.mjs
```

Leave this Terminal window open during the test.
Use Control-C to stop the bridge.
Run only one bridge process for this data directory.

## 8. Test a message and a screenshot

1. Open the `firstmate` channel from your phone.
2. Send a short message.
3. Check for the eyes reaction.
4. Send a small screenshot as an attachment.
5. Check for the eyes reaction on that message.
6. Check the local `data/media` directory for the downloaded file.
7. Wait for firstmate to read the note.
8. Check for the answer in the same channel.

The eyes reaction means that the note was saved.
It does not mean that firstmate has completed the task.
A warning reaction means that saving or announcement needs attention.
The bridge also posts a short warning message.

A new `FM_HOME/state/<task-id>.meta` file creates a task thread within the next scan.
Existing metadata files also create threads on the first scan.
A `title=` or `title:` field in the metadata supplies the opening title.
Send a task-specific message in its thread.
Firstmate receives `[task <task-id>]` before your text.
A message in the main channel remains a general note.
The bridge sends only the state word from matching status lines.
It does not send the rest of a status line.

### How firstmate answers

Firstmate acknowledges each note when it reads the queue.
The bridge does not acknowledge notes on behalf of firstmate.
The supervising firstmate uses its normal queue procedure, including `drain --ack <id>`.
It publishes its answer with this command in the firstmate home:

```sh
bin/fm-inbox.sh reply <id> 'The answer text'
```

`<id>` is the firstmate note ID, not the Discord message ID.
Firstmate can publish one answer for each note.
The bridge reads the JSON receipts and posts the answer in the original channel or thread.
The real receipts command already returns JSON.
It does not accept a `--json` option.
The bridge uses `receipts --after <cursor>` after the first page.
The cursor is the zero-padded reply sequence, not a time or note ID.
The bridge saves the cursor only after it has processed the reply.

To send a file, put a separate line in the answer:

```text
The result is ready.
FILE: /path/to/firstmate/data/result.png
```

The bridge removes each `FILE:` line from the answer text.
It attaches files only from `FM_HOME/data` or the configured bridge media directory.
It accepts up to 10 files, with a limit of 25,000,000 bytes for each file.
A refused file produces a short warning instead of an attachment.
The remaining answer text is still sent.
Discord can apply a lower upload limit.
Use a smaller file if Discord rejects the upload.

### Progress messages

Firstmate can send more than one progress message while a task runs.
Run this command in the bridge repository:

```sh
node src/cli.mjs post --thread task-id --text 'The checks are complete.'
```

Replace `task-id` with a known task ID or an allowed Discord channel or thread ID.
Add an absolute file path when needed:

```sh
node src/cli.mjs post --thread task-id --text 'The image is ready.' --file /path/to/firstmate/data/result.png
```

The command uses the same file roots as answers.
It prints one Discord message ID for each message it sends.
It refuses an unapproved channel or thread.
Do not repeat the command after an uncertain network failure without checking Discord first.
A new CLI invocation is a new progress message.

## 9. Install the launchd job

Stop the foreground bridge first.
Run these commands:

```sh
cd /path/to/firstmate-discord-bridge
command -v node
pwd -P
mkdir -p logs
chmod 700 logs
mkdir -p "$HOME/Library/LaunchAgents"
cp com.firstmate.discord-bridge.plist.example "$HOME/Library/LaunchAgents/com.firstmate.discord-bridge.plist"
open -e "$HOME/Library/LaunchAgents/com.firstmate.discord-bridge.plist"
```

Replace `__NODE_PATH__` with the absolute Node executable path printed by `command -v node`.
Replace `__NODE_DIRECTORY__` with the directory that contains this executable.
Replace each `__REPO_PATH__` with the absolute repository path printed by `pwd -P`.
Use XML escapes if a path contains `&`, `<`, or `>`.
Keep the token in `.env`, not in the property list.
The template adds the Node directory to `PATH` for child processes.
Add any other directories that your firstmate inbox command requires.

Check the edited file:

```sh
plutil -lint "$HOME/Library/LaunchAgents/com.firstmate.discord-bridge.plist"
```

Load the job:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.firstmate.discord-bridge.plist"
```

Read the logs:

```sh
tail -f /path/to/firstmate-discord-bridge/logs/bridge.log /path/to/firstmate-discord-bridge/logs/bridge.error.log
```

Check the job:

```sh
launchctl print "gui/$(id -u)/com.firstmate.discord-bridge"
```

Unload the job:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.firstmate.discord-bridge.plist"
```

The job uses `KeepAlive` to restart the bridge after exit.
Unload it before a configuration change or manual test.
Load it again after the change.
This user job runs only while your macOS user session is active.

### Keep the Mac awake

The bridge cannot receive messages while the Mac sleeps.
For a temporary test, run this command in another Terminal window:

```sh
caffeinate -i
```

Keep the Mac connected to power for continuous use.
Use Control-C to stop `caffeinate`.
This command does not guarantee operation with a closed laptop lid.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Bot is offline | Check Node.js, the token, the launchd log, and the Mac sleep state. |
| No reply | Check the eyes reaction and the firstmate queue. |
| Gateway error `4014` | Enable Message Content Intent on the Bot page. |
| Missing permissions or REST `403` | Check all seven permissions on the parent channel and thread. |
| Wrong IDs | Copy the server, parent channel, and personal user IDs again with Developer Mode. |
| Attachment is not downloaded | Check its size, Discord attachment URL, local free space, and media directory permissions. |
| Firstmate is not running | Saved notes wait in the firstmate queue until firstmate reads them. |
| Note has a warning reaction | Check the inbox executable, its exit status, and the bridge error log. |
| Bot token check fails with `401` | Reset the bot token and replace the local value. |
| REST rejects an upload | Use a smaller file within the server upload limit. |
| State is locked | Check for another bridge or progress command before you change a lock directory. |
| No task thread | Check the task ID format, metadata file, and Create Public Threads permission. |
| Thread no longer appears | Look for an archived thread in Discord. |
| Uncertain delivery | Follow the recovery procedure below. |

### Delivery recovery

The bridge records an outgoing message before it sends it.
If it cannot confirm the result, it checks history for that message nonce.
It does not automatically resend a message with an uncertain result.
This includes an upload rejected by Discord after the delivery record was saved.

1. Unload the launchd job.
2. Stop any foreground bridge process.
3. Back up the full bridge data directory.
4. Find the uncertain record in `state.json` under `deliveries`.
5. Check its channel, start time, and nonce against Discord history.
6. If the message exists, add its Discord message ID as the record's `id` value.
7. If you can prove that Discord did not create the message, remove only that delivery record.
8. Start the bridge again.

Do not remove an uncertain record only because the message is not visible in the current view.
Do not remove the reply cursor, note routes, or thread routes.
A progress command uses a new request on each invocation.
Check for its previous message before you run it again.

An uncertain thread creation uses the `creating` field in its task record.
The bridge first searches active threads for the same task name and bot owner.
If the thread is archived, find it in Discord before repair.
Set the task record's `thread` field to the confirmed thread ID.
Remove its `creating` field after confirmation.
Delete `creating` without a thread ID only if you can prove that no thread was created.

The lock directories contain a local process ID.
A normal stop removes the locks.
A restart removes a lock whose process no longer exists.
If a lock has no valid process ID, stop all bridge commands before manual removal.
Never edit the state while a bridge or progress command runs.

## Official Discord references

These pages were checked with read-only HTTPS GET requests to the official Discord developer site.
Interface menu placement still needs the checks marked above.

- [Gateway](https://discord.com/developers/docs/topics/gateway): intents `GUILDS` (`1 << 0`), `GUILD_MESSAGES` (`1 << 9`), and `MESSAGE_CONTENT` (`1 << 15`); total `33281`; heartbeat jitter; session resume.
- [Opcodes and close codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes): Identify `2`, Resume `6`, Reconnect `7`, Invalid Session `9`, Hello `10`, Heartbeat ACK `11`, rate limit `4008`, and disallowed intent `4014`.
- [Permissions](https://discord.com/developers/docs/topics/permissions): the seven permission bits above and thread permission rules.
- [Channels](https://discord.com/developers/docs/resources/channel#start-thread-without-message): `POST /channels/{channel.id}/threads`, public thread type `11`, names of 1 to 100 characters, and automatic archive periods.
- [Messages](https://discord.com/developers/docs/resources/message#create-message): message content limit, multipart uploads, 25 MiB complete request limit, nonce, and `enforce_nonce`.
- [Rate limits](https://discord.com/developers/docs/topics/rate-limits): `429` replies, `retry_after`, and reset headers.

The bridge file limit is a local safety limit, not a promise about your Discord server upload limit.
The bridge permits no more than 10 files for each answer.
Discord checks a nonce for uniqueness only for a few minutes.
The local delivery record and history check provide the longer-term duplicate guard.
