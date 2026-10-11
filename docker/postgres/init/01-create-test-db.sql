-- Docker runs this only when initializing a new, empty QR Print PostgreSQL volume.
-- This creates the isolated database; it never connects to or alters another server/database.
CREATE DATABASE qr_print_test OWNER qrprint;
