#!/bin/bash
export PATH=$PATH:/usr/local/bin:/usr/bin

ECR_REPO=gwangsan-chat       
REGION=ap-northeast-2
IMAGE_TAG=latest
CONTAINER_NAME=gwangsan-chat  
ACCOUNT_ID=$(/usr/local/bin/aws sts get-caller-identity --query Account --output text)

/usr/local/bin/aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

docker stop $CONTAINER_NAME || true
docker rm $CONTAINER_NAME || true

docker pull $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG

docker run -d \
  --name $CONTAINER_NAME \
  -p 8081:3000 \
  --env-file /home/ubuntu/.env-chat \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG

docker system prune -f