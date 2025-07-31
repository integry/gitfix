FROM node:20-slim

WORKDIR /usr/src/app

# Install docker client to be able to interact with the host's docker daemon
RUN apt-get update && apt-get install -y docker.io

COPY package*.json ./
RUN npm install

COPY . .

# The command will be specified in docker-compose.yml