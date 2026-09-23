FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY sources.config.js ./
COPY server ./server
COPY public ./public
EXPOSE 3000
# Persistent storage: mount a volume at /data (Railway Volume, or docker run -v name:/data).
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
