# Sprint 05: Authentication

**Status:** ⏳ Future
**Estimated Duration:** 2-3 days

---

## Goal

Add user authentication to support multiple users and prepare for production deployment.

---

## Prerequisites

- ✅ Sprints 01-04 complete (core features working)
- ⏳ Ready to onboard real users

---

## Deliverables

- [ ] User registration and login
- [ ] Phoenix.Token-based auth
- [ ] Extension login flow via popup
- [ ] Token stored in chrome.storage
- [ ] WebSocket connections authenticated
- [ ] Per-user data isolation
- [ ] Logout functionality

---

## Technical Tasks

### Task 1: Auth Context (Backend)

- `lib/lossy/accounts.ex`
- `create_user/1`, `authenticate_user/2`
- Password hashing with bcrypt

### Task 2: Auth Controller

- `/api/auth/login` endpoint
- `/api/auth/register` endpoint
- Return JWT token

### Task 3: Socket Auth

- Update `UserSocket.connect/3` to verify token
- Assign user_id to socket

### Task 4: Extension Auth Flow

- Login popup UI
- Store token in chrome.storage
- Pass token to channels

---

## Next Sprint

👉 [Sprint 06 - Polish & UX](./SPRINT_06_polish.md)
