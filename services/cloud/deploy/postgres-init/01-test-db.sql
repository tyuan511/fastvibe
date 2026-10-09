-- A second, throwaway database for `make test-db`; the tests migrate it up and down
-- from scratch, so it must never be the one the service uses.
CREATE DATABASE cloud_test OWNER fastvibe;
