package com.psg.screengolf

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.herohan.uvcapp.CameraHelper
import com.herohan.uvcapp.ICameraHelper
import com.serenegiant.usb.IFrameCallback
import com.serenegiant.usb.Size
import com.serenegiant.usb.UVCCamera
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicInteger
import java.lang.reflect.Proxy
import kotlin.math.abs

/**
 * 폰 스크린골프 앱 껍데기.
 *
 * 안드로이드 브라우저는 OTG로 꽂은 USB 카메라를 대부분 인식하지 못한다(시스템 카메라로 등록되지 않음).
 * 이 앱은 "USB Camera" 앱들과 같은 방식(libusb + libuvc, UVCAndroid 라이브러리)으로 카메라를 직접 열고,
 * 밝기(Y) 프레임을 WebView 안의 웹앱(assets/www/index.html)으로 WebMessagePort를 통해 보낸다.
 *
 * 프레임 형식(ArrayBuffer, little-endian): [u16 w][u16 h][i64 timestamp ns][w*h 바이트 Y]
 * 웹앱 → 앱 명령(JSON 문자열): {cmd:"hello"|"list"|"start"|"stop", width, height, procW}, 그리고 프레임 처리 완료 "ack"
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PSG"
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val MAX_IN_FLIGHT = 3 // 웹앱이 처리 중인 프레임이 이보다 많으면 새 프레임은 버림
    }

    private lateinit var web: WebView
    private lateinit var surfaceView: SurfaceView
    private val main = Handler(Looper.getMainLooper())

    // 웹앱과의 통신 채널
    private var port: WebMessagePortCompat? = null
    private var binaryOk = false

    // UVC 카메라 상태
    private var helper: ICameraHelper? = null
    private var device: UsbDevice? = null
    private var wantRun = false
    private var state = "idle"
    private var reqW = 640
    private var reqH = 480
    @Volatile private var procW = 480
    @Volatile private var frameW = 0
    @Volatile private var frameH = 0
    private var sizes: List<String> = emptyList()
    private var surfaceReady = false

    // 프레임 통계 / 흐름 제어
    private val inFlight = AtomicInteger(0)
    @Volatile private var drops = 0
    @Volatile private var frames = 0
    @Volatile private var lastStatusMs = 0L
    private var yBuf = ByteArray(0)

    // WebView 파일 선택(영상 분석 탭) / 폰 내장 카메라 권한
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private var pendingPermission: PermissionRequest? = null
    private var pendingUsbStart = false
    private val camPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        pendingPermission?.let { if (ok) it.grant(it.resources) else it.deny() }
        pendingPermission = null
        if (pendingUsbStart) {
            pendingUsbStart = false
            if (ok) startCamera()
            else { state = "error"; sendStatus("카메라 권한이 필요합니다. 안드로이드 9 이상에서는 USB 카메라에도 '카메라' 권한이 있어야 합니다.") }
        }
    }
    private fun hasCameraPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val root = FrameLayout(this)
        web = WebView(this)
        surfaceView = SurfaceView(this)
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        // 일부 UVC 카메라는 출력 서피스가 있어야 프레임을 보내므로 아주 작은 서피스를 하나 둔다
        root.addView(surfaceView, FrameLayout.LayoutParams(2, 2))
        setContentView(root)

        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                surfaceReady = true
                if (state == "open") safe { helper?.addSurface(holder.surface, false) }
            }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                surfaceReady = false
                safe { helper?.removeSurface(holder.surface) }
            }
        })

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
                request?.let { loader.shouldInterceptRequest(it.url) }

            override fun onPageFinished(view: WebView?, url: String?) {
                setupBridge()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                val req = request ?: return
                runOnUiThread {
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        req.grant(req.resources)
                    } else {
                        pendingPermission = req
                        camPermission.launch(Manifest.permission.CAMERA)
                    }
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    filePicker.launch(fileChooserParams!!.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        helper = CameraHelper().also { it.setStateCallback(stateCallback) }
        web.loadUrl("$ORIGIN/assets/www/index.html")
    }

    override fun onDestroy() {
        wantRun = false
        safe { helper?.release() }
        helper = null
        safe { port?.close() }
        port = null
        web.destroy()
        super.onDestroy()
    }

    // ---------- 웹앱 통신 ----------
    private fun setupBridge() {
        val need = listOf(
            WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL,
            WebViewFeature.POST_WEB_MESSAGE,
            WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK,
            WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE
        )
        if (!need.all { WebViewFeature.isFeatureSupported(it) }) {
            Log.e(TAG, "WebView가 너무 오래되었습니다. Play 스토어에서 'Android System WebView'를 업데이트하세요.")
            return
        }
        safe { port?.close() }
        val ports = WebViewCompat.createWebMessageChannel(web)
        port = ports[0]
        binaryOk = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        ports[0].setWebMessageCallback(object : WebMessagePortCompat.WebMessageCallbackCompat() {
            override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                val s = try { message?.data } catch (e: Exception) { null } ?: return
                onJsMessage(s)
            }
        })
        WebViewCompat.postWebMessage(web, WebMessageCompat("psg-native-init", arrayOf(ports[1])), Uri.parse(ORIGIN))
        Log.i(TAG, "bridge ready, binary=$binaryOk")
    }

    private fun onJsMessage(s: String) {
        if (s == "ack") {
            if (inFlight.decrementAndGet() < 0) inFlight.set(0)
            return
        }
        val m = try { JSONObject(s) } catch (e: Exception) { return }
        when (m.optString("cmd")) {
            "hello", "list" -> sendStatus(null)
            "start" -> {
                reqW = m.optInt("width", 640)
                reqH = m.optInt("height", 480)
                procW = m.optInt("procW", 480).coerceIn(160, 1280)
                startCamera()
            }
            "stop" -> stopCamera()
        }
    }

    private fun sendStatus(msg: String?, fps: Double = 0.0) {
        val name = try { (device ?: findUvc())?.productName } catch (e: Exception) { null }
        val o = JSONObject()
            .put("type", "status")
            .put("state", state)
            .put("device", name ?: if (findUvc() != null) "USB 카메라" else JSONObject.NULL)
            .put("sizes", JSONArray(sizes))
            .put("drops", drops)
        if (state == "open" && frameW > 0) o.put("size", "${frameW}x${frameH}")
        if (fps > 0) o.put("fps", fps)
        if (msg != null) o.put("msg", msg)
        val text = o.toString()
        main.post { safe { port?.postMessage(WebMessageCompat(text)) } }
    }

    // ---------- UVC 카메라 ----------
    private fun findUvc(): UsbDevice? {
        val um = getSystemService(Context.USB_SERVICE) as UsbManager
        return um.deviceList.values.firstOrNull { d ->
            d.deviceClass == UsbConstants.USB_CLASS_VIDEO ||
                (0 until d.interfaceCount).any { d.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_VIDEO }
        }
    }

    private fun startCamera() {
        if (state == "open") { // 이미 열려 있으면 해상도만 다시 적용
            safe { helper?.stopPreview() }
            onOpened()
            return
        }
        // 안드로이드 9+ 는 UVC(비디오 클래스) USB 장치 접근에도 CAMERA 권한을 요구한다
        if (!hasCameraPermission()) {
            pendingUsbStart = true
            sendStatus("카메라 권한을 요청합니다…")
            camPermission.launch(Manifest.permission.CAMERA)
            return
        }
        val d = findUvc()
        if (d == null) {
            state = "error"
            sendStatus("USB 카메라를 찾지 못했습니다. OTG 연결을 확인하고, 다른 USB 카메라 앱이 켜져 있다면 종료한 뒤 카메라를 다시 꽂아 보세요.")
            return
        }
        wantRun = true
        device = d
        state = "opening"
        sendStatus("USB 권한을 요청합니다… 대화상자에서 '허용'을 눌러 주세요.")
        safe { helper?.selectDevice(d) }
    }

    private fun stopCamera() {
        wantRun = false
        safe { helper?.stopPreview() }
        safe { helper?.closeCamera() }
        state = "closed"
        sendStatus("카메라 정지")
    }

    // StateCallback은 라이브러리 버전에 따라 메서드 구성이 조금씩 달라서(onError 추가 등)
    // 동적 프록시로 구현: 존재하는 콜백은 모두 받고, 모르는 콜백은 무시한다.
    private val stateCallback: ICameraHelper.StateCallback = Proxy.newProxyInstance(
        ICameraHelper.StateCallback::class.java.classLoader,
        arrayOf(ICameraHelper.StateCallback::class.java)
    ) { proxy, method, args ->
        val dev = args?.firstOrNull() as? UsbDevice
        when (method.name) {
            "onAttach" -> {
                sendStatus("USB 장치 연결됨")
                if (wantRun && state != "open" && dev != null) safe { helper?.selectDevice(dev) }
            }
            "onDeviceOpen" -> safe { helper?.openCamera() }
            "onCameraOpen" -> runOnUiThread { onOpened() }
            "onCameraClose" -> {
                if (surfaceReady) safe { helper?.removeSurface(surfaceView.holder.surface) }
                state = "closed"
                sendStatus("카메라가 닫혔습니다")
            }
            "onDetach" -> {
                state = "closed"
                device = null
                sendStatus("USB 카메라가 분리되었습니다")
            }
            "onCancel" -> {
                state = "error"
                wantRun = false
                sendStatus("USB 권한이 거부되었습니다. 다시 '카메라 시작'을 누르고 '허용'을 선택하세요.")
            }
            "onError" -> {
                state = "error"
                val err = args?.getOrNull(1)
                Log.e(TAG, "camera error: $err")
                sendStatus("카메라 오류: ${(err as? Throwable)?.message ?: err ?: "알 수 없음"}")
            }
        }
        when (method.name) { // Object 기본 메서드
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.getOrNull(0)
            "toString" -> "PSG.StateCallback"
            else -> null
        }
    } as ICameraHelper.StateCallback

    private fun onOpened() {
        val h = helper ?: return
        val list: List<Size> = try { h.supportedSizeList ?: emptyList() } catch (e: Exception) { emptyList() }
        sizes = list.map { "${it.width}x${it.height}" }.distinct()
        val pick = list.firstOrNull { it.width == reqW && it.height == reqH }
            ?: list.minByOrNull { abs(it.width - reqW) + abs(it.height - reqH) }
        if (pick != null) safe { h.previewSize = pick }
        val ps = try { h.previewSize } catch (e: Exception) { null }
        frameW = ps?.width ?: reqW
        frameH = ps?.height ?: reqH
        inFlight.set(0); drops = 0; frames = 0; lastStatusMs = SystemClock.uptimeMillis()
        safe { h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21) }
        safe { h.startPreview() }
        if (surfaceReady) safe { h.addSurface(surfaceView.holder.surface, false) }
        state = "open"
        sendStatus("USB 카메라 열림 (${frameW}×${frameH}) · 모드: ${ps ?: "기본"}")
    }

    // 카메라 스레드에서 호출됨
    private val frameCallback = IFrameCallback { buf -> onFrame(buf) }

    private fun onFrame(buf: ByteBuffer?) {
        if (buf == null) return
        val tNs = System.nanoTime()
        frames++
        val nowMs = SystemClock.uptimeMillis()
        if (nowMs - lastStatusMs >= 1000) {
            val fps = frames * 1000.0 / (nowMs - lastStatusMs)
            frames = 0; lastStatusMs = nowMs
            sendStatus(null, fps)
        }
        val p = port ?: return
        if (inFlight.get() >= MAX_IN_FLIGHT) { drops++; return }
        val w = frameW
        val h = frameH
        val n = w * h
        if (w <= 0 || h <= 0 || buf.capacity() < n) return

        // NV21의 앞부분 w*h 바이트가 밝기(Y) 평면 = 그레이스케일
        if (yBuf.size < n) yBuf = ByteArray(n)
        buf.position(0)
        buf.get(yBuf, 0, n)

        val step = maxOf(1, w / procW) // 정수 배율 박스 평균으로 축소
        val ow = w / step
        val oh = h / step
        val out = ByteArray(12 + ow * oh)
        ByteBuffer.wrap(out, 0, 12).order(ByteOrder.LITTLE_ENDIAN).apply {
            putShort(ow.toShort()); putShort(oh.toShort()); putLong(tNs)
        }
        if (step == 1) {
            System.arraycopy(yBuf, 0, out, 12, n)
        } else {
            val area = step * step
            var o = 12
            for (oy in 0 until oh) {
                val y0 = oy * step
                for (ox in 0 until ow) {
                    var sum = 0
                    val x0 = ox * step
                    for (dy in 0 until step) {
                        var i = (y0 + dy) * w + x0
                        for (dx in 0 until step) { sum += yBuf[i].toInt() and 0xFF; i++ }
                    }
                    out[o++] = (sum / area).toByte()
                }
            }
        }

        inFlight.incrementAndGet()
        main.post {
            try {
                if (binaryOk) p.postMessage(WebMessageCompat(out))
                else p.postMessage(WebMessageCompat("b64:" + Base64.encodeToString(out, Base64.NO_WRAP)))
            } catch (e: Exception) {
                inFlight.decrementAndGet()
                Log.w(TAG, "postMessage failed", e)
            }
        }
    }

    private fun safe(block: () -> Unit) {
        try { block() } catch (e: Exception) { Log.w(TAG, "ignored", e) }
    }
}
