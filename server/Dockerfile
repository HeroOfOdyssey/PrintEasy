FROM node:18-alpine AS base

WORKDIR /app

# Copy package metadata first to leverage Docker cache
COPY package.json .
COPY package-lock.json* ./

RUN npm install --omit=dev

# Copy application code
COPY . .

EXPOSE 3000

CMD ["node", "app.js"]
