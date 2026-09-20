-- name: ListPosts :many
SELECT id, title, body FROM post ORDER BY id;

-- name: GetPostByID :one
SELECT id, title, body FROM post WHERE id = $1;

-- name: CreatePost :one
INSERT INTO post (title, body) VALUES ($1, $2) RETURNING id, title, body;

-- name: UpdatePost :one
UPDATE post SET title = $2, body = $3 WHERE id = $1 RETURNING id, title, body;

-- name: DeletePost :exec
DELETE FROM post WHERE id = $1;
