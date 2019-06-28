FROM node:slim

WORKDIR /app

RUN apt-get update && apt-get install -y unzip && sh -c 'curl https://rclone.org/install.sh | bash'
COPY package*.json /app/
RUN npm i
COPY . /app

CMD ["node", "client.js"]
