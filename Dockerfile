ARG DENO_VERSION=2.7.14

FROM denoland/deno:${DENO_VERSION}

WORKDIR /app

# Cache dependencies
COPY deno.json deno.lock ./
RUN deno install

# Copy source
COPY . .

EXPOSE 8080

CMD ["sh", "-c", "deno task serve"]
