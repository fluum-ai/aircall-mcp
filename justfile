set dotenv-load
set shell := ["sh", "-eu", "-c"]

image := "aircall-mcp"
tag := env("IMAGE_TAG", "local")
port := env("PORT", "8888")

# List available recipes
default:
    @just --list

# Build the production Docker image
build:
    docker build -t {{image}}:{{tag}} .

# Run the image locally (needs AIRCALL_API_ID and AIRCALL_API_TOKEN in .env)
run: build
    docker run --rm -it \
        --name aircall-mcp \
        -p {{port}}:8000 \
        -e AIRCALL_API_ID \
        -e AIRCALL_API_TOKEN \
        -e MCP_AUTH_TOKEN \
        {{image}}:{{tag}}

# Compile TypeScript
compile:
    npm run build

# Run the test suite
test:
    npm test
