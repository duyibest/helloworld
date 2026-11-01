package main

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

//go:embed web/*
var assets embed.FS

func handler() http.Handler {
	mux := http.NewServeMux()
	cache := &snapshotCache{}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/availability", func(w http.ResponseWriter, r *http.Request) {
		passengers := 1
		if value := r.URL.Query().Get("passengers"); value != "" {
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > 9 {
				http.Error(w, "passengers must be 1–9", 400)
				return
			}
			passengers = n
		}
		snapshot, state := cache.read(r.Context())
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(dashboard(snapshot, time.Now(), passengers, state)); err != nil {
			log.Print("encode dashboard: ", err)
		}
	})
	public, _ := fs.Sub(assets, "web")
	files := http.FileServer(http.FS(public))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/app.js" && r.URL.Path != "/style.css" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		files.ServeHTTP(w, r)
	})
	return mux
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "refresh" {
		if err := refresh(context.Background()); err != nil {
			log.Fatal(err)
		}
		log.Print("snapshot refreshed")
		return
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{Addr: ":" + port, Handler: handler(), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Listening on :%s", port)
	log.Fatal(server.ListenAndServe())
}
