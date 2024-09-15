#!/bin/bash

# Check if an argument is provided
if [ -z "$1" ]; then
  echo "No argument provided. Please provide 'install', 'test', or a URL."
  exit 1
fi

# Handle different argument values
case "$1" in
  install)
    echo "Installing dependencies..."
    npm i
    echo "Done."
    ;;
  test)
    echo "Running tests..."
    npm test
    echo "Done."
    ;;
  *)
    if [[ "$1" == *"npmjs.com"* || "$1" == *"github.com"* ]]; then
      echo "Calculating metrics for the provided package URL..."
      npx tsx calculate_metrics "$1"
      echo "Done."
    else
      echo "Invalid argument. Please provide 'install', 'test', or a valid npmjs or GitHub URL."
      exit 1
    fi
    ;;
esac