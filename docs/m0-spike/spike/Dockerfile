FROM node:26-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 8099
CMD ["node", "src/index.mjs"]
