#!/bin/bash
set -e

echo "Provisioning LocalStack SQS FIFO queues..."

# Criar Dead-Letter Queue (DLQ)
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

# Obter ARN da DLQ
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

# Criar Fila de Entrada Principal com Redrive Policy apontando para DLQ
REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"3\"}"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=15,RedrivePolicy='$REDRIVE_POLICY'"

# Criar Fila de Eventos Publicados da Outbox
awslocal sqs create-queue \
  --queue-name integration-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS FIFO queues provisioned successfully!"

