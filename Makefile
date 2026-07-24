.PHONY: sync check lint

sync:
	python scripts/sync.py

check:
	python scripts/sync.py --check

lint:
	python scripts/lint_style.py
