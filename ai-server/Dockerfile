# Use the official Node.js 20 LTS image (pinned patch version)
FROM node:20.18-slim

# Install dependencies for Tesseract OCR and Sharp
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy the trained data for Tesseract
COPY eng.traineddata /usr/share/tesseract-ocr/5/tessdata/

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
