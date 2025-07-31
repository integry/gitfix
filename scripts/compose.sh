#!/bin/bash

set -e

COMMAND=$1

case $COMMAND in
  up)
    echo "Starting up Docker Compose environment..."
    docker-compose up --build -d
    echo "Environment is up and running."
    ;;
  down)
    echo "Stopping Docker Compose environment..."
    docker-compose down
    echo "Environment is stopped."
    ;;
  logs)
    echo "Tailing logs..."
    docker-compose logs -f
    ;;
  build)
    echo "Forcing a rebuild of all images..."
    docker-compose build --no-cache
    echo "Images rebuilt."
    ;;
  *)
    echo "Usage: $0 {up|down|logs|build}"
    exit 1
    ;;
esac