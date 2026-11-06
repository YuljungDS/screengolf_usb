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
        versionCode = 2
        versionName = "0.2"
        ndk {
            // UVC 드라이버(네이티브 라이브러리) 대상 CPU
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
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
