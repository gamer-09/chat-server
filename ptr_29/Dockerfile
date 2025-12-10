# Simple production Dockerfile for ptr_29 chat server
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

# Environment
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
