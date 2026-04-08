@echo off
REM ============================================================
REM Taranis Data Room — Build & Deploy to AWS
REM Run this from: C:\Users\mark\Claude Cowork\Taranis Dataroom\taranis-dataroom
REM Prerequisites: Docker Desktop running, AWS CLI installed
REM ============================================================

set AWS_REGION=eu-west-2
set AWS_ACCOUNT_ID=571600836975
set ECR_REGISTRY=%AWS_ACCOUNT_ID%.dkr.ecr.%AWS_REGION%.amazonaws.com

echo.
echo === Step 1: Login to ECR ===
aws ecr get-login-password --region %AWS_REGION% | docker login --username AWS --password-stdin %ECR_REGISTRY%
if errorlevel 1 (
    echo ERROR: ECR login failed. Check AWS CLI credentials.
    pause
    exit /b 1
)

echo.
echo === Step 2: Build API image ===
cd packages\api
docker build -t %ECR_REGISTRY%/taranis-dataroom/api:latest .
if errorlevel 1 (
    echo ERROR: API build failed.
    pause
    exit /b 1
)
cd ..\..

echo.
echo === Step 3: Build Web image ===
cd packages\web
docker build -t %ECR_REGISTRY%/taranis-dataroom/web:latest .
if errorlevel 1 (
    echo ERROR: Web build failed.
    pause
    exit /b 1
)
cd ..\..

echo.
echo === Step 4: Push API image to ECR ===
docker push %ECR_REGISTRY%/taranis-dataroom/api:latest
if errorlevel 1 (
    echo ERROR: API push failed.
    pause
    exit /b 1
)

echo.
echo === Step 5: Push Web image to ECR ===
docker push %ECR_REGISTRY%/taranis-dataroom/web:latest
if errorlevel 1 (
    echo ERROR: Web push failed.
    pause
    exit /b 1
)

echo.
echo === Step 6: Start ECS service (1 task) ===
aws ecs update-service --cluster taranis-dataroom --service taranis-dataroom-service --desired-count 1 --force-new-deployment --region %AWS_REGION%

echo.
echo ============================================================
echo SUCCESS! Images pushed and service starting.
echo.
echo The service will take 2-3 minutes to start.
echo Check status: aws ecs describe-services --cluster taranis-dataroom --services taranis-dataroom-service --query "services[0].deployments[0].runningCount" --region eu-west-2
echo.
echo Once running, visit: https://dataroom.taraniscapital.com
echo Login: admin@taraniscapital.com / REDACTED-SEED-PASSWORD
echo IMPORTANT: Change the admin password immediately after first login!
echo ============================================================
pause
