package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/a-h/templ"
	"github.com/jackc/pgx/v5/pgxpool"

	"hello-go/internal/store"
	"hello-go/internal/web"
	"hello-go/pages"
)

func main() {
	ctx := context.Background()

	mux := http.NewServeMux()

	pool, err := pgxpool.New(ctx, os.Getenv("GOOSE_DBSTRING"))
	if err != nil {
		log.Printf("warning: failed to create db pool: %v", err)
	} else {
		defer pool.Close()

		queries := store.New(pool)

		(&web.PostsHandler{Queries: queries}).Register(mux)
	}

	component := pages.Home()

	mux.Handle("/", templ.Handler(component))
	mux.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.Dir("assets"))))

	fmt.Println("Listening on :8090")
	http.ListenAndServe(":8090", mux)
}
