package httpapi

import (
	"errors"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"
)

// Error is a failure a handler means to show the client: a status, a stable code a
// client can branch on, and a sentence for people.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// NewError builds an Error; handlers return it as their error.
func NewError(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

// errorHandler renders every error as {"error": {"code", "message", "request_id"}}.
// Anything that is not an *Error or a *fiber.Error is a bug: the client gets a
// generic 500 and the details go to the log, never to the response.
func errorHandler(log *zap.Logger) fiber.ErrorHandler {
	return func(c fiber.Ctx, err error) error {
		status, code, message := fiber.StatusInternalServerError, "internal_error", "internal server error"

		var apiErr *Error
		var fiberErr *fiber.Error
		switch {
		case errors.As(err, &apiErr):
			status, code, message = apiErr.Status, apiErr.Code, apiErr.Message
		case errors.As(err, &fiberErr):
			status, message = fiberErr.Code, fiberErr.Message
			code = codeForStatus(status)
		default:
			log.Error("unhandled error", zap.String("request_id", RequestID(c)), zap.Error(err))
		}

		c.Set(fiber.HeaderCacheControl, "no-store")
		return c.Status(status).JSON(fiber.Map{"error": fiber.Map{
			"code":       code,
			"message":    message,
			"request_id": RequestID(c),
		}})
	}
}

func codeForStatus(status int) string {
	switch status {
	case fiber.StatusBadRequest:
		return "bad_request"
	case fiber.StatusUnauthorized:
		return "unauthorized"
	case fiber.StatusForbidden:
		return "forbidden"
	case fiber.StatusNotFound:
		return "not_found"
	case fiber.StatusMethodNotAllowed:
		return "method_not_allowed"
	case fiber.StatusRequestEntityTooLarge:
		return "payload_too_large"
	case fiber.StatusTooManyRequests:
		return "rate_limited"
	case fiber.StatusServiceUnavailable:
		return "unavailable"
	}
	if status >= 500 {
		return "internal_error"
	}
	return "error"
}
