package com.jeopardy.api.analytics;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

@Service
public class ReportExportService {

    private static final Logger log = LoggerFactory.getLogger(ReportExportService.class);
    private static final int STREAM_BUFFER_BYTES = 8192;

    private final AnalyticsQueryBuilder queryBuilder;
    private final HttpClient httpClient;
    private final String clickhouseHttpUrl;
    private final String clickhouseDatabase;
    private final String basicAuthHeader;

    public ReportExportService(
            AnalyticsQueryBuilder queryBuilder,
            @Value("${jeopardy.datasources.clickhouse.http-url:http://localhost:8123}") String clickhouseHttpUrl,
            @Value("${jeopardy.datasources.clickhouse.database:jeopardy}") String clickhouseDatabase,
            @Value("${jeopardy.datasources.clickhouse.username:jeopardy}") String username,
            @Value("${jeopardy.datasources.clickhouse.password:jeopardy}") String password) {
        this.queryBuilder = queryBuilder;
        this.clickhouseHttpUrl = clickhouseHttpUrl.endsWith("/")
                ? clickhouseHttpUrl.substring(0, clickhouseHttpUrl.length() - 1)
                : clickhouseHttpUrl;
        this.clickhouseDatabase = clickhouseDatabase;
        String credentials = username + ":" + password;
        this.basicAuthHeader = "Basic " + Base64.getEncoder()
                .encodeToString(credentials.getBytes(StandardCharsets.UTF_8));
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    public record ExportStreamResult(String format, String contentType, String filename, StreamingResponseBody body) {}

    public ExportStreamResult prepareExport(
            String format,
            int hours,
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            String templateId,
            String errorCode,
            Map<String, String> allQueryParams) {

        Map<String, String> dimensions = queryBuilder.extractAndValidateDimensions(allQueryParams);
        AnalyticsQueryBuilder.ClickHouseHttpQuery query = queryBuilder.buildClickHouseExportQuery(
                format, hours, orderFamily, orderType, accountType, channel, templateId, errorCode, dimensions);

        String contentType = "parquet".equals(query.format())
                ? "application/vnd.apache.parquet"
                : "text/csv; charset=utf-8";
        String filename = "jeopardy-telemetry-" + hours + "h." + query.format();

        URI targetUri = buildClickHouseUri(query.httpParams());

        StreamingResponseBody body = outputStream -> {
            HttpRequest request = HttpRequest.newBuilder(targetUri)
                    .timeout(Duration.ofMinutes(10))
                    .header("Authorization", basicAuthHeader)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .POST(HttpRequest.BodyPublishers.ofString(query.sql(), StandardCharsets.UTF_8))
                    .build();

            try {
                HttpResponse<InputStream> response = httpClient.send(
                        request, HttpResponse.BodyHandlers.ofInputStream());

                try (InputStream in = response.body()) {
                    if (response.statusCode() != 200) {
                        byte[] errBytes = in.readNBytes(4096);
                        String errMsg = new String(errBytes, StandardCharsets.UTF_8);
                        log.error("ClickHouse export HTTP {} error: {}", response.statusCode(), errMsg);
                        throw new IOException("ClickHouse export failed with HTTP "
                                + response.statusCode() + ": " + errMsg);
                    }

                    byte[] buffer = new byte[STREAM_BUFFER_BYTES];
                    int bytesRead;
                    while ((bytesRead = in.read(buffer)) != -1) {
                        outputStream.write(buffer, 0, bytesRead);
                    }
                    outputStream.flush();
                }
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                throw new IOException("ClickHouse streaming export interrupted", ex);
            }
        };

        return new ExportStreamResult(query.format(), contentType, filename, body);
    }

    URI buildClickHouseUri(Map<String, String> httpParams) {
        StringBuilder queryString = new StringBuilder();
        queryString.append("database=").append(encode(clickhouseDatabase));
        if (httpParams != null && !httpParams.isEmpty()) {
            String paramPairs = httpParams.entrySet().stream()
                    .map(e -> "param_" + encode(e.getKey()) + "=" + encode(e.getValue()))
                    .collect(Collectors.joining("&"));
            queryString.append("&").append(paramPairs);
        }
        return URI.create(clickhouseHttpUrl + "/?" + queryString);
    }

    private String encode(String val) {
        return URLEncoder.encode(val != null ? val : "", StandardCharsets.UTF_8);
    }
}
