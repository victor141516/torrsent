FROM node:slim

WORKDIR /app

RUN apt-get update && apt-get install rclone
COPY package*.json /app/
RUN npm i
COPY . /app

CMD ["node", "client.js"]
