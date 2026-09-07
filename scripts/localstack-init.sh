#!/bin/bash
# Runs inside the LocalStack container once SQS is ready.
set -e

create_fifo () {
  awslocal sqs create-queue \
    --queue-name "$1" \
    --attributes "FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30"
}

create_fifo "wager-transactions-dlq.fifo"
create_fifo "wager-events.fifo"

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "http://localhost:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --queue-name "wager-transactions.fifo" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

echo "SQS queues ready."
