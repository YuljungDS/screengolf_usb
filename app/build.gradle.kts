plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.psg.screengolf"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.psg.screengolf"
        minSdk = 26
        targetSdk = 34
        versionCode = 9
        versionName = "0.7"
        ndk {
            // UVC 드라이버(네이티브 라이브러리) 대상 CPU
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    // 고정 서명 키: GitHub 자동 빌드마다 임시 디버그 키가 새로 만들어져 서명이 달라지면
    // 폰에서 '업데이트 설치'가 거부됨(기존 앱과 충돌) → 저장소에 넣은 같은 키로 항상 서명
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug-fixed.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        jniLibs { useLegacyPackaging = true }
    }
    lint {
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    // USB(UVC) 카메라를 안드로이드 카메라 시스템을 거치지 않고 직접 여는 라이브러리 (libusb + libuvc 기반)
    implementation("com.herohan:UVCAndroid:1.0.13")
}
