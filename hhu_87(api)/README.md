# hhu_87 - Node.js Express Server

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file based on `.env.example` if you want to override the default port:
   ```ini
   PORT=4008
   ```

## Running the Server

- Start in normal mode:
  ```bash
  npm start
  ```

- Start in development mode (with automatic restarts using nodemon):
  ```bash
  npm run dev
  ```

## Endpoints

- `GET /` – returns a simple JSON message.
- `GET /healthz` – health check endpoint that returns `{ "status": "ok" }`.
