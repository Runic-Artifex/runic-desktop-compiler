import type { HandleClientError } from '@sveltejs/kit';

// Kit's default hook logs the error with its stack trace; this one does not.
export const handleError: HandleClientError = ({ status, message }) => {
  return { message: `${message} (${status})` };
};
