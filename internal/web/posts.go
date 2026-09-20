// Package web renders and handles the server-side HTML CRUD pages for posts.
package web

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/a-h/templ"
	"github.com/jackc/pgx/v5"

	"hello-go/internal/store"
	"hello-go/pages"
)

// PostsHandler wires the HTML posts routes (list, form, create, update,
// delete) to the generated store queries.
type PostsHandler struct {
	Queries *store.Queries
}

// Register attaches the posts HTML routes to mux.
func (h *PostsHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /posts", h.index)
	mux.HandleFunc("GET /posts/new", h.new)
	mux.HandleFunc("POST /posts", h.create)
	mux.HandleFunc("GET /posts/{id}/edit", h.edit)
	mux.HandleFunc("POST /posts/{id}/edit", h.update)
	mux.HandleFunc("POST /posts/{id}/delete", h.delete)
}

func (h *PostsHandler) index(w http.ResponseWriter, r *http.Request) {
	posts, err := h.Queries.ListPosts(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	render(w, r, pages.PostsIndex(posts))
}

func (h *PostsHandler) new(w http.ResponseWriter, r *http.Request) {
	render(w, r, pages.PostForm(nil, pages.PostFormData{}))
}

func (h *PostsHandler) create(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	title := strings.TrimSpace(r.PostFormValue("title"))
	body := strings.TrimSpace(r.PostFormValue("body"))

	if title == "" {
		render(w, r, pages.PostForm(nil, pages.PostFormData{Title: title, Body: body, Error: "Title is required."}))
		return
	}

	_, err := h.Queries.CreatePost(r.Context(), store.CreatePostParams{
		Title: strPtr(title),
		Body:  strPtr(body),
	})
	if err != nil {
		render(w, r, pages.PostForm(nil, pages.PostFormData{Title: title, Body: body, Error: err.Error()}))
		return
	}

	http.Redirect(w, r, "/posts", http.StatusSeeOther)
}

func (h *PostsHandler) edit(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	post, err := h.Queries.GetPostByID(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	render(w, r, pages.PostForm(&post, pages.PostFormData{Title: strVal(post.Title), Body: strVal(post.Body)}))
}

func (h *PostsHandler) update(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	title := strings.TrimSpace(r.PostFormValue("title"))
	body := strings.TrimSpace(r.PostFormValue("body"))

	if title == "" {
		post := store.Post{ID: id}
		render(w, r, pages.PostForm(&post, pages.PostFormData{Title: title, Body: body, Error: "Title is required."}))
		return
	}

	post, err := h.Queries.UpdatePost(r.Context(), store.UpdatePostParams{
		ID:    id,
		Title: strPtr(title),
		Body:  strPtr(body),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		render(w, r, pages.PostForm(&post, pages.PostFormData{Title: title, Body: body, Error: err.Error()}))
		return
	}

	http.Redirect(w, r, "/posts", http.StatusSeeOther)
}

func (h *PostsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := h.Queries.DeletePost(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/posts", http.StatusSeeOther)
}

func parseID(r *http.Request) (int32, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 32)
	if err != nil {
		return 0, errors.New("invalid post id")
	}
	return int32(id), nil
}

func strPtr(s string) *string {
	return &s
}

func strVal(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func render(w http.ResponseWriter, r *http.Request, c templ.Component) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := c.Render(r.Context(), w); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
