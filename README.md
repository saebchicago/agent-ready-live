# Agent-Ready Live

Agent-Ready Live is a Twitch chat game where viewers send a polite robot to check whether public websites are ready for AI agents. Phase P1 connects a bot account to Twitch chat and responds to `!ping`.

## Requirements

- Node.js 22 or newer
- A Twitch developer application
- A separate Twitch bot account
- Twitch CLI for local EventSub testing

## Setup

1. Create a Twitch application in the developer console.
2. Set its OAuth redirect URL to exactly `http://localhost:3000`.
3. Copy `.env.example` to `.env` and fill in the Twitch client ID, client secret, bot user ID, channel user ID, token path, and contact email.
4. Install dependencies with `npm install`.
5. Log into Twitch as the bot in an incognito window, then run `npm run auth` and open the printed URL.
6. Find the broadcaster account ID with `npm run whois -- <login>` and set it as `TWITCH_CHANNEL_USER_ID`.
7. Make the bot a moderator in the broadcaster's channel.
8. Start the bot with `npm run dev`.

The default token path is `~/.agent-ready-live/tokens.json`. Keep it outside the repository.

## Local Twitch CLI testing

Start the Twitch CLI EventSub WebSocket mock server:

```sh
twitch event websocket start-server --require-subscription
```

In a second terminal, connect the bot to the local WebSocket and subscription endpoints:

```sh
npm run dev -- --eventsub-url ws://127.0.0.1:8080/ws --eventsub-api-url http://127.0.0.1:8080/eventsub/subscriptions
```

The CLI prints commands for forwarding mock events and testing reconnects. Run `twitch event websocket reconnect` to exercise the handoff. Live mode uses `wss://eventsub.wss.twitch.tv/ws` and does not need these arguments.

Run the unit tests with:

```sh
npm test
```

The credential-free replay command is a stub in Phase P1:

```sh
npm run replay
```
