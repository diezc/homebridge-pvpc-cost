FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json tsconfig.json eslint.config.js config.schema.json README.md LICENSE ./
COPY src ./src
COPY test ./test

RUN npm install
RUN npm run lint
RUN npm run build
RUN npm run test
RUN npm run smoke
RUN npm run pack:dryrun

FROM build AS pack

RUN PACKAGE_FILE="$(npm pack)" && mv "$PACKAGE_FILE" /tmp/homebridge-pvpc-cost.tgz

FROM homebridge/homebridge:latest

WORKDIR /opt/homebridge-pvpc-cost

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/config.schema.json ./config.schema.json
COPY --from=build /app/dist ./dist

RUN npm install -g /opt/homebridge-pvpc-cost

ENV TZ=Europe/Madrid

EXPOSE 8581

CMD ["homebridge", "-I", "-U", "/homebridge"]
