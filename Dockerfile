# Optional: only needed if you want to run the app in a container.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build
# Exec form, running node directly. NOT "npm start": npm does not forward
# SIGTERM to node, so your shutdown hooks would never run in ECS/Docker.
CMD ["node", "dist/main.js"]
