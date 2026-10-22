FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=$(date +%y%m%d)" -o /wirgloo ./cmd/wirgloo

FROM gcr.io/distroless/static:nonroot
COPY --from=build /wirgloo /wirgloo
EXPOSE 6677
ENTRYPOINT ["/wirgloo"]
