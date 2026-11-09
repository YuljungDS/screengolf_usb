package com.psg.screengolf

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
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
import java.io.File
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
    // 같은 장치를 두 번 열면 라이브러리가 "the device is occupied" 오류를 내므로, 선택·열기 요청을 한 번만 보낸다
    private var selectPending = false
    private var openPending = false
    private var occupiedRetries = 0
    private var lastClaimDiag = ""
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
            "save" -> saveImage(m.optString("name", "screengolf.png"), m.optString("data"))
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

    // 진단용 화면 저장: 웹앱이 보낸 PNG(base64)를 '다운로드/ScreenGolf' 폴더에 저장
    private fun saveImage(name: String, b64: String) {
        val res = JSONObject().put("type", "saved")
        try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val fileName = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val where: String
            if (Build.VERSION.SDK_INT >= 29) {
                val cv = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ScreenGolf")
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv) ?: throw Exception("저장 위치를 만들 수 없음")
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw Exception("파일을 열 수 없음")
                where = "다운로드/ScreenGolf/$fileName"
            } else {
                val dir = File(getExternalFilesDir(null), "ScreenGolf"); dir.mkdirs()
                val f = File(dir, fileName); f.writeBytes(bytes); where = f.absolutePath
            }
            res.put("path", where)
        } catch (e: Exception) {
            res.put("error", e.message ?: e.toString())
        }
        val text = res.toString()
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
        val opened = try { helper?.isCameraOpened == true } catch (e: Exception) { false }
        if (state == "open" || opened) { // 이미 열려 있으면 해상도만 다시 적용
            wantRun = true
            safe { helper?.stopPreview() }
            onOpened()
            return
        }
        if (selectPending || openPending) {
            sendStatus("USB 카메라를 여는 중입니다… 잠시만 기다려 주세요.")
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
        occupiedRetries = 0
        selectPending = true
        sendStatus("USB 권한을 요청합니다… 대화상자에서 '허용'을 눌러 주세요.")
        safe { helper?.selectDevice(d) }
    }

    /** 비디오 인터페이스를 강제 점유했다가 놓아, 커널 드라이버를 분리한다. 결과 문자열(진단용)을 돌려준다. */
    private fun releaseKernelDriver(d: UsbDevice): String {
        val um = getSystemService(Context.USB_SERVICE) as UsbManager
        if (!um.hasPermission(d)) return "권한 없음"
        val conn = try { um.openDevice(d) } catch (e: Exception) { null } ?: return "openDevice 실패"
        val sb = StringBuilder()
        try {
            val seen = HashSet<Int>()
            for (i in 0 until d.interfaceCount) {
                val itf = d.getInterface(i)
                if (itf.interfaceClass != UsbConstants.USB_CLASS_VIDEO || !seen.add(itf.id)) continue
                val ok = try { conn.claimInterface(itf, true) } catch (e: Exception) { false }
                sb.append("if").append(itf.id).append(if (ok) ":ok " else ":busy ")
                if (ok) safe { conn.releaseInterface(itf) }
            }
        } finally {
            safe { conn.close() }
        }
        return sb.toString().trim().ifEmpty { "비디오 인터페이스 없음" }
    }

    private fun openCameraOnce() {
        if (openPending) return
        val opened = try { helper?.isCameraOpened == true } catch (e: Exception) { false }
        if (opened) { runOnUiThread { onOpened() }; return }
        openPending = true
        safe { helper?.openCamera() }
        main.postDelayed({
            if (openPending && state != "open") {
                openPending = false
                sendStatus("카메라 열기 응답이 없습니다. 카메라를 다시 꽂고 '카메라 시작'을 눌러 주세요.")
            }
        }, 8000)
    }

    private fun stopCamera() {
        wantRun = false
        selectPending = false
        openPending = false
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
                // 시작 버튼을 누른 뒤 카메라를 새로 꽂은 경우에만 선택 (이미 선택 중이면 중복 호출 금지)
                if (wantRun && state == "closed" && !selectPending && dev != null) {
                    selectPending = true
                    state = "opening"
                    safe { helper?.selectDevice(dev) }
                }
            }
            "onDeviceOpen" -> {
                selectPending = false
                // USB 인터페이스를 커널 드라이버(uvcvideo)가 잡고 있으면 라이브러리가 BUSY(-6)로 실패한다.
                // 안드로이드 API의 강제 점유(claimInterface force=true)로 커널 드라이버를 먼저 떼어낸다.
                val diag = (dev ?: device)?.let { releaseKernelDriver(it) } ?: "장치 없음"
                lastClaimDiag = diag
                Log.i(TAG, "claim test: $diag")
                if (diag.contains("busy")) {
                    sendStatus("USB 인터페이스 점유 실패($diag) — 다른 앱이 카메라를 쓰고 있습니다. 설정 → 애플리케이션 → USB Camera → '강제 중지' 후 카메라를 다시 꽂아 주세요.")
                }
                openCameraOnce()
            }
            "onCameraOpen" -> {
                openPending = false
                occupiedRetries = 0
                runOnUiThread { onOpened() }
            }
            "onCameraClose" -> {
                if (surfaceReady) safe { helper?.removeSurface(surfaceView.holder.surface) }
                state = "closed"
                sendStatus("카메라가 닫혔습니다")
            }
            "onDetach" -> {
                state = "closed"
                selectPending = false
                openPending = false
                device = null
                sendStatus("USB 카메라가 분리되었습니다")
            }
            "onCancel" -> {
                selectPending = false
                state = "error"
                wantRun = false
                sendStatus("USB 권한이 거부되었습니다. 다시 '카메라 시작'을 누르고 '허용'을 선택하세요.")
            }
            "onError" -> {
                openPending = false
                selectPending = false
                val err = args?.getOrNull(1)
                val code = try { err?.javaClass?.getMethod("getCode")?.invoke(err) as? Int } catch (e: Exception) { null }
                val text = ((err as? Throwable)?.message ?: err?.toString() ?: "알 수 없음") +
                    (if (code != null) " [code $code]" else "") +
                    (if (lastClaimDiag.isNotEmpty()) " [점유검사 $lastClaimDiag]" else "")
                Log.e(TAG, "camera error: $text")
                if (text.contains("occupied", ignoreCase = true) && occupiedRetries < 2 && wantRun) {
                    // 이미 열린 카메라 핸들이 남아 있는 경우: 닫고 잠시 후 다시 연다
                    occupiedRetries++
                    sendStatus("카메라가 사용 중이라 다시 여는 중… (${occupiedRetries}/2)")
                    safe { helper?.closeCamera() }
                    main.postDelayed({
                        if (wantRun) {
                            device?.let { lastClaimDiag = releaseKernelDriver(it) }
                            openCameraOnce()
                        }
                    }, 700L * occupiedRetries)
                } else {
                    state = "error"
                    val hint = if (text.contains("occupied", ignoreCase = true))
                        " — 다른 앱이 USB 카메라를 잡고 있습니다. 설정 → 애플리케이션 → (USB Camera 등) → '강제 중지' 후, 카메라를 뽑았다 다시 꽂고 시작하세요."
                    else ""
                    sendStatus("카메라 오류: $text$hint")
                }
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
