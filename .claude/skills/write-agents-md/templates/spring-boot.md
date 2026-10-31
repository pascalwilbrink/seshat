<!-- Starting point for Spring Boot repos. Keep only what you confirmed in the code. -->

## Conventions
- Package by feature/domain, not by layer; each feature owns its controller, service, repository and DTOs.
- Constructor injection only (no field `@Autowired`); prefer `final` fields.
- Request/response DTOs are records; never expose JPA entities from controllers.
- Validate input with Jakarta Bean Validation (`@Valid`, `@NotNull`, …) on DTOs.
- Map exceptions to HTTP responses centrally (`@RestControllerAdvice`), using RFC 7807 `ProblemDetail` where the project does.
- Configuration via `@ConfigurationProperties` classes, not scattered `@Value`.
- Schema changes go through the project's migration tool (Flyway/Liquibase); never edit an applied migration.
- Unit tests with JUnit 5 + AssertJ; slice tests (`@WebMvcTest`, `@DataJpaTest`) over full `@SpringBootTest` where possible.
- Use the Maven/Gradle wrapper (`./mvnw`, `./gradlew`), never a globally installed build tool.
