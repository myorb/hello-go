// Package api exposes an HTTP JSON CRUD interface over the posts store.
package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"hello-go/internal/store"
)

// PostsHandler wires HTTP routes to the generated store queries for posts.
type PostsHandler struct {
	Queries *store.Queries
}

// Register attaches the posts CRUD routes to mux.
func (h *PostsHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/posts", h.list)
	mux.HandleFunc("POST /api/posts", h.create)
	mux.HandleFunc("GET /api/posts/{id}", h.get)
	mux.HandleFunc("PUT /api/posts/{id}", h.update)
	mux.HandleFunc("DELETE /api/posts/{id}", h.delete)
}

type postPayload struct {
	Title *string `json:"title"`
	Body  *string `json:"body"`
}

func (h *PostsHandler) list(w http.ResponseWriter, r *http.Request) {
	posts, err := h.Queries.ListPosts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, posts)
}

func (h *PostsHandler) get(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	post, err := h.Queries.GetPostByID(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, errors.New("post not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, post)
}

func (h *PostsHandler) create(w http.ResponseWriter, r *http.Request) {
	var payload postPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	post, err := h.Queries.CreatePost(r.Context(), store.CreatePostParams{
		Title: payload.Title,
		Body:  payload.Body,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, post)
}

func (h *PostsHandler) update(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	var payload postPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	post, err := h.Queries.UpdatePost(r.Context(), store.UpdatePostParams{
		ID:    id,
		Title: payload.Title,
		Body:  payload.Body,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, errors.New("post not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, post)
}

func (h *PostsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if err := h.Queries.DeletePost(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseID(r *http.Request) (int32, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 32)
	if err != nil {
		return 0, errors.New("invalid post id")
	}
	return int32(id), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
