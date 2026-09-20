package main

import (
	"fmt"
	"net/http"

	"github.com/a-h/templ"

	"hello-go/pages"
)

func main() {
	component := pages.Home()
	
	http.Handle("/", templ.Handler(component))
	http.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.Dir("assets"))))

	fmt.Println("Listening on :8090")
	http.ListenAndServe(":8090", nil)
}