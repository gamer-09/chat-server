# chat-server

![Archived](https://img.shields.io/badge/status-archived-red)

> **This repository has been archived and is now read-only.**

Real-time chat server.

> **This project is no longer maintained.** This is an old version of the chat site and **no further updates or fixes will be posted here.** Development moved to the new chat site below.

## ⚠️ The chat site in `ptr_29/` is 231 commits behind

The chat app in this repository is in [`ptr_29/`](ptr_29). It is the **original prototype** and is now **231 commits behind** the actively developed chat site, which is where the project continued:

- **New source —** https://github.com/gamer-09/chat-site
- **Live site —** https://gamer-09.github.io/chat-site/

### Features the new chat site has that `ptr_29/` does not

| Area | What the new chat site adds |
|---|---|
| **Accounts** | 🔐 Login/register gate before the app opens; unique usernames; bcrypt+pepper hashed passwords (SHA-256 on-device first); 13+ age confirmation and Terms/Privacy acceptance; password-verified **Delete Account** that fully erases the account and its content. `ptr_29` has no accounts. |
| **Backend** | Runs hosted on **GitHub Pages + Supabase** (Realtime, RLS, SQL migrations) with accounts that follow you across devices; the Node/Socket.IO server is kept as a self-hosted fallback. |
| **Room roles** | Add a member/admin by **Client ID or username** (server-resolved), **Kick**, **Ban / Allow rejoin**, and *claim ownership* of an orphaned room. `ptr_29` only has basic admin/member lists. |
| **Reactions** | Emoji reactions with a hover tooltip showing who reacted. |
| **@mentions** | `@` autocomplete (online first), highlighted mention chips, in-app toast and system notification. |
| **Message search** | Highlights every match, live match counter, ↑/↓ navigation, ✕ to cancel. |
| **Jump to newest** | Floating ↓ button with a count of messages that arrived while you were reading. |
| **Out-of-app notifications** | Service-worker notifications for messages in other rooms, mentions and inbox requests — background tabs and locked phones. |
| **Hosted file sharing** | Allow-listed images up to 5 MB and documents (PDF, TXT, CSV, JSON, DOCX, XLSX, PPTX) up to 10 MB, backed by Supabase Storage. |
| **Glass UI** | Frosted panels over a **live animated canvas backdrop**, with a Still/Animate switch and dark/light glass palettes. |
| **Themes** | 🌙/☀️ dark-light toggle remembered per browser; links and read receipts re-tint per theme. |
| **People panel & profiles** | Online/Offline toggle with live counts, search filter, last-seen times, and member profile cards with activity stats. |
| **Client-ID requests** | Consent-based inbox: reasoned request → approve/deny, then revoke sharing later. |
| **Safe links** | Allow-list validation that blocks unsafe protocols, private/local targets, credential-obfuscated and punycode look-alike links, risky downloads and link spam. |
| **PWA & offline** | Service worker, web manifest, icons, network-first shell. |
| **Guided tour & help** | One-time guided tour for new accounts plus a 9-slide built-in help guide and Contact-the-operator modal. |
| **Mobile layout** | Dedicated mobile sidebar and adaptive keyboard handling. |
| **Deploy tooling** | Dockerfile, Procfile, GitHub Pages workflow, and a build-freshness guard. |

_Commit count and feature list reflect the new chat site as of commit [`6441862`](https://github.com/gamer-09/chat-site/commit/6441862)._

## Setup

1. Clone the repository
2. Navigate to the `ptr_29` directory
3. Run `npm install` to install dependencies
4. Run `npm run dev` to start the development server with nodemon
5. Run `npm start` to start the production server

## Dependencies
- Express.js
- Socket.IO
- CORS
- Nodemon (development only)
