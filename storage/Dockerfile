# Build the community server from an official tagged source release. The old
# minio/minio Docker Hub image is no longer publicly available.
FROM golang:1.24-alpine AS build
RUN apk add --no-cache git ca-certificates
RUN git clone --depth 1 --branch RELEASE.2025-10-15T17-29-55Z https://github.com/minio/minio.git /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /minio .

FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates \
  && adduser -D -u 1000 minio \
  && mkdir /data && chown minio:minio /data
COPY --from=build /minio /usr/local/bin/minio
USER minio
EXPOSE 9000
ENTRYPOINT ["minio"]
