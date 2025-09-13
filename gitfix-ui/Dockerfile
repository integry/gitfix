# Stage 1: Build the React app
FROM node:20-slim as build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve the app with a lightweight server
FROM node:20-slim
WORKDIR /app
COPY --from=build /app/dist /app/dist
COPY serve.json /app/serve.json
RUN npm install -g serve
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:5173", "-c", "../serve.json"]