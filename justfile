check:
    bun run check

test:
    bun test

benchmark:
    bun run benchmark

smoke:
    bun run smoke

publish result:
    bun run src/publish.ts {{result}}
