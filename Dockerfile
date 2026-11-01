FROM gcr.io/distroless/static-debian12:nonroot
COPY --chmod=0555 dist/helloworld /helloworld
USER 65532:65532
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/helloworld"]
