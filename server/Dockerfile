FROM node:18-alpine AS base

WORKDIR /app

RUN apk add --no-cache fontconfig ttf-dejavu

# Copy package metadata first to leverage Docker cache
COPY package.json .
COPY package-lock.json* ./

RUN npm install --omit=dev

# Copy application code
COPY . .

EXPOSE 3000

CMD ["node", "app.js"]
