# Use the official Node.js 20 LTS image (pinned patch version)
FROM node:20.18-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Build dashboard React app
RUN cd src/dashboard && npm install && npm run build && rm -rf node_modules

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose the port Cloud Run expects
EXPOSE 8080

# Start the application
CMD ["node", "src/index.js"]
