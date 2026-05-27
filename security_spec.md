# Firebase Security Rules Specification

This document details the data integrity and security rules designed for the Ranking collection in the Saint Shotoku Listening Game.

## 1. Data Invariants

- A ranking document represents a score submission.
- Once created, ranking entries are immutable (no updates or deletes allowed by clients).
- Submitters can create entries only. No malicious modification of previous scores.
- Document keys must be valid Firestore IDs.
- Submissions must validate the integrity of:
  - `name`: String, 1 to 8 characters.
  - `score`: Integer, between 0 and 30000.
  - `mode`: String, either "normal", "hard", or "hell".
  - `createdAt`: Server timestamp (`request.time`).

## 2. The "Dirty Dozen" Payloads

Here are test cases that must fail permission verification:

1. **Malicious Update**: Attempting to edit a previously registered score.
2. **Score Overlord**: Registering a score greater than 30,000 (e.g., 999,999).
3. **Score Underflow**: Registering a score below 0 (e.g., -100).
4. **Name Overflow**: Registering a name longer than 8 characters.
5. **Name Empty**: Registering an empty name.
6. **Unknown Fields**: Injecting phantom fields like `isAdmin: true` into the document.
7. **Client Timestamp Tampering**: Submitting a custom local timestamp rather than `request.time`.
8. **Invalid Mode**: Submitting a mode not in the approved list (e.g., `extreme`).
9. **Deletion Attempt**: Deleting any ranking entry.
10. **Listing All Users**: Access tracking shouldn't disclose general non-ranking collections.
11. **Null Payload**: Creating an empty document.
12. **Malicious ID**: Creating a document with a non-alphanumeric or massive ID.

## 3. Security Rules Draft

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Global Safety Net
    match /{document=**} {
      allow read, write: if false;
    }

    // Help Helper Functions
    function isValidId(id) { 
      return id is string && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\-]+$'); 
    }
    
    function incoming() { 
      return request.resource.data; 
    }
    
    // Schema Validation
    function isValidRanking(data) {
      return data.keys().hasAll(['name', 'score', 'mode', 'createdAt'])
        && data.keys().size() == 4
        && data.name is string 
        && data.name.size() >= 1 
        && data.name.size() <= 8
        && data.score is int 
        && data.score >= 0 
        && data.score <= 30000
        && data.mode is string 
        && (data.mode == 'normal' || data.mode == 'hard' || data.mode == 'hell')
        && data.createdAt == request.time;
    }

    match /rankings/{rankingId} {
      allow create: if isValidId(rankingId) && isValidRanking(incoming());
      allow list: if query.limit <= 20; // Allow queries if limited to top 20
      allow get: if true;
      allow update, delete: if false; // Rankings are strictly write-once, immutable
    }
  }
}
```
