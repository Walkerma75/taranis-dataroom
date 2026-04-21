@echo off
REM ============================================================
REM Taranis Data Room - Build & Deploy API ONLY to AWS
REM Use this when only the API package has changed (faster than full deploy).
REM Run from: C:\Users\mark\Claude Cowork\Taranis Dataroom\taranis-dataroom
REM Prerequisites: Docker Desktop running, AWS CLI installed
REM ============================================================

REM Pin to the TaranisCapital AWS profile so it never uses disruptsmedia or default.
set AWS_PROFILE=TaranisCapital
set AWS_REGION=eu-west-2
set AWS_ACCOUNT_ID=571600836975
set ECR_REGISTRY=%AWS_ACCOUNT_ID%.dkr.ecr.%AWS_REGION%.amazonaws.com

echo Using AWS profile: %AWS_PROFILE%
aws sts get-caller-identity --query "Account" --output text
if errorlevel 1 (
    echo ERROR: Could not verify AWS credentials for profile %AWS_PROFILE%.
    pause
    exit /b 1
)

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
echo === Step 3: Push API image to ECR ===
docker push %ECR_REGISTRY%/taranis-dataroom/api:latest
if errorlevel 1 (
    echo ERROR: API push failed.
    pause
    exit /b 1
)

echo.
echo === Step 4: Force new ECS deployment ===
aws ecs update-service --cluster taranis-dataroom --service taranis-dataroom-service --force-new-deployment --region %AWS_REGION% --no-cli-pager
if errorlevel 1 (
    echo ERROR: ECS deployment trigger failed.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo SUCCESS! API image pushed and service restarting.
echo.
echo The new task will take 2-3 minutes to become healthy.
echo.
echo Check status:
echo   aws ecs describe-services --cluster taranis-dataroom --services taranis-dataroom-service --query "services[0].deployments" --region eu-west-2
echo.
echo Once running, visit: https://dataroom.taraniscapital.com
echo ============================================================
pause
