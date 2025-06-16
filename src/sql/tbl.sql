CREATE TABLE IF NOT EXISTS clients (
    cid TEXT PRIMARY KEY,
    -- json blob representing this client
    meta TEXT,
    -- 0 for play, 1 for stripe
    kind INTEGER,
    -- created at timestamp
    ctime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- updated at timestamp
    mtime TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)

CREATE TABLE IF NOT EXISTS playorders (
    purchasetoken TEXT PRIMARY KEY,
    -- product identifier
    prod TEXT,
    -- json blob representing this order
    -- todo: use generated cols? developers.cloudflare.com/d1/reference/generated-columns/
    meta TEXT,
    -- client id
    cid TEXT NOT NULL,
    -- created at timestamp
    ctime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cid) REFERENCES clients(cid) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS stripeorders (
    sid TEXT PRIMARY KEY,
    -- product identifier
    prod TEXT,
    -- json blob representing this order
    meta TEXT,
    -- client id
    cid TEXT NOT NULL,
    -- created at timestamp
    ctime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cid) REFERENCES clients(cid) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS ws (
    sessiontoken TEXT PRIMARY KEY,
    -- user identifier
    userid TEXT NOT NULL,
    -- stripe subscription id
    sid TEXT,
    -- play order purchase token
    purchasetoken TEXT,
    -- created at timestamp
    ctime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- updated at timestamp
    mtime TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    -- restrict deletion unless ws has been notified and sessiontoken is invalidated
    FOREIGN KEY (sid) REFERENCES stripeorders(sid) ON DELETE RESTRICT,
    FOREIGN KEY (purchasetoken) REFERENCES playorders(purchasetoken) ON DELETE RESTRICT,
)
