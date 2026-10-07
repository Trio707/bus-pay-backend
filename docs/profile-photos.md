# Profile photos

Conductors and Wakala accounts can upload one profile photo. Passengers are not part of this feature.

Photos are stored as files, not in PostgreSQL. The `User` row keeps `profilePhotoKey` and `profilePhotoUpdatedAt` only.

## Local development

`PROFILE_PHOTO_DIR` defaults to `uploads/profile-photos` under the backend working directory. That folder is gitignored. Set the variable to move the folder. Production can replace `ProfilePhotoStorage` without changing the profile API.

## Rules

- Authenticated conductor or wakala only. The user id comes from the JWT, not the request body.
- Upload limit: 1 MB.
- Accepted content: JPEG, PNG, WebP. The server checks the image itself.
- Stored result: square JPEG, at most 512×512, metadata stripped, usually under 250 KB.
- Admin can view a thumbnail at `GET /admin/users/:id/profile-photo`. Admin cannot upload on someone else's behalf.

## API

- `GET /auth/profile` returns a small profile with `profilePhotoUrl` and `profilePhotoUpdatedAt`. No image bytes.
- `POST /auth/profile/photo` field `photo`.
- `GET /auth/profile/photo` returns the JPEG with `ETag` and `Cache-Control: private, max-age=86400`. `If-None-Match` can return 304.
- `DELETE /auth/profile/photo` clears the photo. Deleting when none exists is a success with `removed: false`.

Replacing a photo writes the new file first, updates the user, then deletes the old file. A failed update deletes the new file and leaves the previous photo in place.
